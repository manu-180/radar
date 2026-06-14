# Detección por Firehose de Bluesky + filtro en capas

> Fuente de verdad de la migración de la detección de Bluesky: de **search-poll**
> (búsquedas puntuales cada 20 min) a **firehose** (consumir TODO el stream de la
> red en tiempo real). El pre-filtro determinístico pasa a ser el cerebro de la
> detección y la IA queda gateada por costo.
>
> Estado al 2026-06-14: **app-side implementado y verde** (lint/typecheck/test).
> Falta el worker (servicio nuevo en Railway) + inputs del usuario (env/infra).

## Por qué

El search-poll sólo pesca posts que matchean las queries exactas que configuramos
→ se escapa cualquiera que lo diga distinto, y no detecta a quien no nos sigue. El
firehose (Jetstream) entrega **todos** los `app.bsky.feed.post` de la red; ahí el
filtro barato decide qué es lead. Objetivo: detectar a cualquiera que en español
pida una web/app, sin que el costo de IA se dispare.

## Decisiones tomadas (no re-litigar)

- **Solo español.** El worker descarta lo que franc detecta como inglés.
- **Tope DURO de US$5 acumulados** para la IA (no por día). Al llegar, se frena
  todo (clasificación + encolado) y se avisa por WhatsApp. Editable / "ilimitado"
  desde `/config`. Es un experimento para medir cuánto rinde $5.
- **Worker dedicado** en Railway (aislado del worker de Telegram, que hoy ni corre).
- **Capa 3 (embeddings) DIFERIDA** (YAGNI): primero medir con keywords + IA; si
  faltan paráfrasis, sumar embeddings **locales** (gratis) en el worker, no API paga.
- **Approach A**: el worker corre las capas baratas y escribe `leads` directo en
  Supabase. Todo el downstream (`/api/process` → notify → engage → conversación)
  queda igual.

## Arquitectura

```
Jetstream (wss, todos los posts) ──► worker-firehose (Railway, persistente)
                                        │  Capa 1: idioma (franc)
                                        │  Capa 2: keywords (tabla `keywords`)
                                        │  → INSERT leads (llm_status='pending')
                                        ▼
                          Supabase `leads`  ──►  /api/process (Vercel)
                                                   Capa 4: Haiku→Sonnet (PAGO)
                                                   gateado por presupuesto US$5
                                                 ──► notify → engage → charla
```

- El firehose es **push**; no encaja en `SourceAdapter` (pull). Por eso es un
  worker, no una fuente. El `source` de los leads sigue siendo `'bluesky'` (así el
  canal de outreach por DM y el dashboard funcionan sin cambios).
- **Corre en paralelo al search-poll** durante la transición. El dedup por
  `content_hash` evita doble proceso. El search-poll se apaga **después** de
  verificar el worker en vivo (ver Rollout).

## Las 4 capas

| Capa | Dónde | Costo | Qué hace |
|---|---|---|---|
| 1 · Idioma | worker | gratis | `detectLang` (franc). Descarta `'en'`; conserva `'es'` **y `'other'`** (posts cortos que franc no clasifica) para no perder recall. |
| 2 · Keywords | worker | gratis | `prefilter()` de `lib/filter/match.ts` sobre el texto normalizado. Red ancha de intención. |
| 3 · Embeddings | — | — | **Diferida.** No implementada. |
| 4 · IA | `/api/process` | **pago** | `classifyLead` (Haiku→Sonnet). Único paso pago, gateado por presupuesto. |

**Matiz de las keywords (importante):** el vocabulario de intención en español se
siembra con `lang='any'` (no `'es'`) — así también aplica a los posts `'other'`
(cortos) que rescatamos en la Capa 1. Son frases multi-palabra para no generar
falsos positivos por substring (nada de `app` suelto). La precisión fina la pone
la IA (Capa 4). Editables desde la tabla `keywords` / dashboard.

## Shared module (una sola copia del filtro)

- `lib/filter/normalize.ts` — puro (franc + crypto): `normalizeText`, `contentHash`,
  `detectLang`. Sin `server-only`.
- `lib/filter/match.ts` — **puro** (NEW): `prefilter`, `decidePrefilter`, tipos
  `Keyword`/`PrefilterResult`. Sin red, sin DB, sin `server-only`.
- `lib/filter/prefilter.ts` — `server-only`: `loadKeywords()` (lee la DB) +
  re-exporta lo de `match.ts` para no tocar call-sites.

El worker importa `normalize.ts` + `match.ts` (puros) y carga las keywords con su
propio cliente de Supabase. Sólo tienen imports `import type` con alias `@/` (los
borra esbuild); para `tsc`, el worker mapea `@/* → ../*` en su tsconfig.

## Kill-switch de presupuesto (US$5)

Settings nuevas (tabla `settings`, sembradas en `0011`):
- `classifier_budget_usd` = `5`. `<= 0`/ausente = **ilimitado**.
- `classifier_spend_baseline_usd` = gasto acumulado al aplicar la migración (para
  medir "desde ahora").
- `classifier_paused` = `false`. El kill-switch lo prende.

Mecánica:
- **Gasto efectivo** = `classifier_spend_total()` (RPC, suma `llm_cost_usd` de los
  `done`) − `baseline`.
- En `/api/process`, al inicio: si `paused` → no clasifica y vuelve. Si efectivo
  `>= budget` → `pauseClassifier()` + aviso WhatsApp (una vez) + vuelve. Los leads
  quedan `pending` (parqueados, no se pierden).
- El **worker** lee `classifier_paused` cada ~60 s; si está en `true`, **deja de
  insertar** (cuenta y loguea los descartados) para no inflar la cola.
- `health/check` no marca "ai-backlog" si `classifier_paused` (pausa intencional).
- **Reanudar**: subir `classifier_budget_usd` (o ponerlo en `0`/ilimitado) y poner
  `classifier_paused=false` desde `/config`.

## El worker (`worker-firehose/`) — a construir

Servicio Node persistente (mirror de `worker/`: tsconfig, esbuild, Procfile, README).

1. **Conexión**: WebSocket al Jetstream de Bluesky
   (`wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post`).
   ⚠️ Verificar el endpoint y el shape del evento contra los docs actuales de
   Jetstream/atproto antes de codear (AGENTS.md).
2. **Por evento** `commit` / `operation:'create'` / `collection:'app.bsky.feed.post'`:
   - texto = `commit.record.text`; `did` = repo; `rkey` = `commit.rkey`.
   - **Capa 1**: `detectLang(text)`; si `=== 'en'` → descartar.
   - **Capa 2**: `prefilter({title:'', body:text}, lang, keywords)`; si no pasa → descartar.
3. **Sobreviviente** (pocos/día): resolver el **handle** del `did` (cachear) para
   construir la URL `https://bsky.app/profile/{handle}/post/{rkey}` IGUAL que el
   search-poll → mismo `content_hash` → dedup perfecto entre ambos.
   - `INSERT` en `leads` (cliente supabase-js propio, service role), con:
     `source='bluesky'`, `external_id` = `at://{did}/app.bsky.feed.post/{rkey}`,
     `content_hash` = `contentHash(item)` con `item` reconstruido IGUAL que el
     search-poll (mismo `title`/`body`/`url`) → dedup perfecto. ⚠️ El `title`
     persistido NO es `''`: es la primera línea no vacía recortada a 120 (como
     `toRawItem`); usar `''` rompería el hash. (El *match* de keywords sí corre con
     `title:''`, que es equivalente porque el título es la 1ª línea del body.)
     `body=text`, `url`, `author=handle`, `lang`, `posted_at`, `raw=evento`,
     `prefilter_matched`, `llm_status='pending'`, `notify_status='pending'`,
     `contact_channel='bluesky'`, `contact_key=did`, `contact_ref={did}`,
     `contact_handle='@'+handle`. Usar upsert con `ignoreDuplicates` (dos índices
     únicos: `content_hash` y `(source, external_id)`).
4. **Presupuesto**: cachear `classifier_paused` (refresco ~60 s); si `true`, no insertar.
5. **Robustez**: persistir el `cursor` (`time_us`) cada pocos segundos; reconectar
   desde el cursor tras una caída (no perder posts). Backoff en la reconexión.
   Keywords: recargar de la DB cada ~5 min (editable sin redeploy).
6. **Throughput**: si el substring sobre N keywords se vuelve caro al ritmo del
   stream, compilar a Aho-Corasick/regex única. Arrancar simple y medir.

Env del worker (Railway): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, opcional
`JETSTREAM_URL`. (No manda WhatsApp: el aviso de tope lo manda `/api/process`.)

## Migración `0011_firehose_detection.sql` (aplicada/aplicar)

- Siembra el vocabulario de keywords `lang='any'` (idempotente, guard `NOT EXISTS`).
- Siembra los settings del presupuesto (`on conflict do nothing`; baseline = SUM actual).
- Crea la función `classifier_spend_total()`.
- **No** desactiva el search-poll de Bluesky (se hace después, manual).

## Rollout

1. ✅ App-side (shared module, migración, settings, kill-switch, guard de health) — verde.
2. ⏳ Aplicar `0011` a la DB del radar (vía MCP de Supabase).
3. ⏳ Construir + verificar `worker-firehose/` (typecheck/build).
4. ⏳ (usuario) Crear el servicio en Railway, cargar env, deployar.
5. ⏳ Verificar en vivo: leads de `bluesky` entrando, calidad, $ consumido.
6. ⏳ Apagar el search-poll: `update sources set enabled=false where slug='bluesky';`
   (recién cuando el worker esté verificado, para no abrir hueco de detección).
7. Observar ~1 semana → ajustar keywords / decidir si hace falta la Capa 3.

## Inputs pendientes del usuario

- [ ] Railway: crear el servicio del worker (root `worker-firehose/`), cargar
      `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, deployar.
- [ ] Confirmar que las DMs de Bluesky de la cuenta están en "Everybody" (ya estaba
      pendiente; sin eso el outreach no entrega).
- [ ] (Opcional) ajustar el tope `classifier_budget_usd` desde `/config`.

# Radar Autopilot — Progreso

> Estado vivo del trabajo. La arquitectura está en [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> Una sesión nueva debe poder reconstruir TODO desde acá + el repo, sin el chat.

**Última actualización:** 2026-06-14 (sesión 5: LIVE en producción + fix del bug de DMs de Bluesky)

## 🟢 ESTADO: EN VIVO EN PRODUCCIÓN (autopilot ON, cap 5/día)
Desplegado en **https://radar-five-indol.vercel.app** (Vercel, auto-deploy desde
`main`; Supabase `eurhkkwhsolvixvwlgto`; cron pg_cron con 7 jobs). `outreach_enabled=true`,
`outreach_daily_cap=5`. Playbook con la oferta real de APEX. Detecta, clasifica,
contacta por Bluesky, conversa y hace handoff por WhatsApp — todo solo.

### Sesión 5 — LIVE + fix del canal Bluesky
- **Bug real arreglado:** `lib/channels/bluesky.ts` proxeaba el chat por `bsky.social`
  (el *entryway*), pero las cuentas viven en `*.host.bsky.network` → los DMs daban
  **501 MethodNotImplemented** (ningún mensaje salía). Ahora resuelve el PDS real del
  `didDoc` de `createSession` y proxea el chat por ahí. Verificado en prod (resuelve
  `stropharia.us-west.host.bsky.network`, inbound poll 200, sin 501). NO requiere
  cambiar credenciales en Vercel (el app password viejo sirve).
- **Diagnóstico descartado:** no era el scope del app password (ambos tienen DM
  access) ni un setting de la cuenta — era el host hardcodeado en el código.

> Histórico de sesiones 1-4 más abajo (build, deploy desde cero, activación).

### Sesión 3 — verificación + targeting + diagnóstico de infraestructura
- **Re-verificado en verde** desde cero: `lint` ✓ · `typecheck` ✓ · `vitest` 111 ✓.
- **Diagnóstico de deploy (importante para activar):** NO existe todavía un proyecto
  del radar ni en **Supabase** (el único alcanzable por MCP es "Videos") ni en
  **Vercel** (50 proyectos en el team "Manuel's projects", ninguno es el radar).
  Tampoco hay `.env.local`. ⇒ La activación es **desde cero**: provisionar DB +
  primer deploy + cargar credenciales. No es un bug; es infra que sólo Manuel puede
  crear con su cuenta.
- **No hay gap de código.** Auditoría end-to-end confirmó que el loop automático
  está completo y cableado (detectar → clasificar → DM en frío → entrante → responder
  con IA → followup → handoff). Las **fuentes ya vienen sembradas** en `0001`
  (Bluesky habilitado con queries es/en; keywords de "necesito una pagina", etc.).
- **Mejora de targeting → migración `0010_web_targeting.sql`** (aditiva, idempotente,
  forward-only): suma a la fuente Bluesky queries de intención "página web"
  ("necesito una página web", "need a website", "necesito una landing", …). Las
  queries originales sólo decían "hire a developer"; ahora también pesca a quien
  busca puntualmente una web. **Aplicarla junto con el resto de migraciones.**
- **Camino mínimo recomendado para arrancar (el más barato y 100% automático):
  sólo Bluesky.** No necesita worker de Railway, ni Evolution/WhatsApp, ni teléfonos
  — sólo un app password de Bluesky. Telegram y WhatsApp se suman después.
- **Secretos generados** (CRON_SECRET, AUTH_SECRET, WEBHOOK_SECRET): se entregaron a
  Manuel por chat (no se commitean). Pegar en las env vars de Vercel al deployar.

### Activación en curso (sesión 3)
- **Supabase del radar:** proyecto ref **`eurhkkwhsolvixvwlgto`**.
  - ✅ **MCP `supabase-radar` configurado** en `~/.claude.json` (global, persiste
    entre sesiones; reiniciar Claude Code para que cargue).
  - ✅ **v1 ya estaba aplicada** (tablas leads/sources/runs/settings/keywords/
    notifications + RPCs claim_*).
  - ✅ **Migraciones 0009 + 0010 aplicadas y verificadas** (vía Management API):
    tablas `conversations`/`messages` ✓, función `claim_leads_to_engage` ✓,
    `outreach_enabled=false` (shadow) ✓, Bluesky 17 queries (con "página web") ✓.
  - Pendiente: correr `supabase/cron.sql` con el `app_url` real (post-deploy) +
    guardar `cron_secret`/`webhook_secret` en el Vault.
- **WhatsApp = reusar la Evolution API de apex-leads** (misma de Railway). Verificado:
  el cliente del radar (`lib/notify/evolution.ts`) usa exactamente la misma forma
  (`POST /message/sendText/{instancia}`, header `apikey`) → reuse drop-in.
  - `EVOLUTION_API_URL=https://evolution-api-production-3571.up.railway.app`
  - `EVOLUTION_API_KEY`: en `apex_hunter/apex-leads/.env.local` (no se commitea).
  - `EVOLUTION_INSTANCE`: elegir una instancia `open`. Disponibles al 2026-06-13:
    `wa-sim-01`, `wa-sim-02`, `wa-manu-01`, `wa-manu-celu-viejo`, `wa-juli`,
    `wa-manu-prueba-celu-nuevo`. (Recomendado: una de repuesto, ej. `wa-sim-01`.)
- **IA premium:** el closer (`lib/ai/agent.ts → DEFAULT_AGENT_MODEL`) pasó de
  Haiku a **`claude-sonnet-4-6`** (decisión de Manuel: inteligencia premium en la
  venta, con buen costo). El clasificador de alto volumen sigue Haiku→Sonnet.
- **Config de deploy confirmada:** Anthropic key NUEVA (provista; va sólo a Vercel,
  no se commitea) · `EVOLUTION_INSTANCE=wa-manu-celu-viejo` ·
  `EVOLUTION_API_URL=https://evolution-api-production-3571.up.railway.app`.
### ✅ DEPLOY COMPLETO — SISTEMA VIVO (sesión 3, en modo shadow)
- **Producción:** https://radar-five-indol.vercel.app (Vercel, proyecto `radar`,
  auto-deploy desde `main`). Dashboard: login con `DASHBOARD_PASSWORD`.
- **Env vars** cargadas en Vercel (incluida Anthropic key nueva, Supabase, Evolution
  `wa-manu-celu-viejo`, OWNER_WHATSAPP `+5491134272488`, secretos).
- **Cron pg_cron:** 7 jobs activos apuntando a la URL de prod; `cron_secret` en el
  Vault sincronizado con Vercel. Verificado: dispatch→poll→process→inbound corren
  solos. Se limpió el job legacy `lead-detector-outreach`.
- **Verificado end-to-end:** HackerNews detectó 384 leads en la primera corrida.
- **2 bugs reales arreglados en esta sesión:**
  1. `lib/env.ts` — APP_URL ahora deriva de `VERCEL_PROJECT_PRODUCTION_URL` (URL
     pública estable); antes usaba `VERCEL_URL`, que está detrás de Deployment
     Protection (401) y rompía el fan-out interno del dispatcher → 0 polls.
  2. `lib/db/leads.ts` — `persistLeads` chunquea los `.in()`; antes un lote grande
     (HN, cientos de items) excedía el largo de URL de PostgREST → 400 y se perdían
     todos los leads de esa corrida.
- **Estado:** `outreach_enabled=false` (shadow). Detecta, clasifica y **avisa al
  dueño por WhatsApp**, pero NO contacta prospectos hasta que Manuel prenda el switch.
- **Bluesky (canal de outreach):** ✅ credenciales cargadas en Vercel y
  desplegadas (`BLUESKY_IDENTIFIER=manunv.bsky.social`). Source y channel
  verificados en producción (poll 200, sin errores de auth). Recordatorio: tener
  las DMs de la cuenta en "Everybody" para poder escribir a desconocidos.

### ✅ VERIFICACIÓN COMPLETA (sesión 4) — todo verde
- Redeploy con las vars de Bluesky activo en prod. Probado end-to-end:
  poll/process/notify/engage/inbound/health corren; **health-check `healthy: true`**.
- **WhatsApp confirmado**: el health-check mandó el aviso "recuperado" a
  `OWNER_WHATSAPP` (Evolution OK).
- **1166 leads** detectados, 35 clasificados, 1 "hiring" real. `outreach_enabled=false`.
- **Reddit deshabilitado** (`sources.enabled=false`): sin credenciales, sólo
  generaba errores y falsas alarmas. Re-habilitable si se agregan creds.
- **Bugfix:** `app/api/health/check/route.ts → checkSources` ahora sólo marca
  "source-down" en fuentes **habilitadas** (una apagada a propósito no está caída;
  antes quedaba marcada para siempre y mandaba recordatorios cada 6 h).
### 🟢 LIVE — AUTOPILOT ENCENDIDO (sesión 4)
- **`outreach_enabled = true`** + **`outreach_daily_cap = 5`** (arranque conservador;
  subir cuando el primer puñado de conversaciones reales se vea bien).
- **Playbook cargado con la oferta real de APEX** (en `settings.agent_playbook`):
  landing $300k · web interactiva c/backend $600k · e-commerce/plataforma $900k ·
  3 cuotas sin interés · **boceto gratis primero** · plazo hasta 15 días ·
  ejemplos por nivel (handy/bylumainvita/assistify; tallermarcelo/botlode;
  moda/ponchospanish) · web theapexweb.com. (Editable desde `/config`.)
- **Pendiente de Manuel:** poner las DMs de Bluesky en "Everybody"
  (Chat → engranaje → Permitir mensajes nuevos de → Todos), si no Bluesky no entrega.
- El código `DEFAULT_PLAYBOOK` (fallback) sigue con el genérico; la verdad vive en
  la DB. Ver la oferta real en memoria [reference-apex-oferta].

### Sesión 2 — hardening (sin pasos manuales pendientes en el código)
- **Webhook secret con fallback por query param** (`verifyWebhookSecret`): además
  del header `x-webhook-secret`, acepta `?s=<secret>` en la URL. Resuelve el caso
  de Evolution API cuando no permite headers custom → WhatsApp inbound anda de una.
- **Worker verificado**: instala y typechequea limpio; relay inbound + `/send`
  revisados (shape del payload matchea el adapter de Telegram).
- **DEPLOY.md** actualizado (webhook por header o query param).

### ⚠️ Sobre aplicar la migración 0009 (lo único que NO pude hacer yo)
La base de datos del radar **no es alcanzable desde esta sesión**: revisé todos los
proyectos Supabase conectados por MCP (videos, virus, poncho, oficiosapp,
libre-albedrio; botlode/conductor caídos; assistify sin auth) y **ninguno es el del
radar**. No voy a aplicar una migración a la DB equivocada. **Manuel: aplicá
`supabase/migrations/0009_conversations.sql`** desde el SQL Editor de tu proyecto
Supabase del radar (o decime cuál es y la aplico). Es idempotente y aditiva.

---

## Fuente de verdad / orden de lectura para una sesión nueva
1. `docs/ARCHITECTURE.md` — diseño completo de v2.
2. `docs/PROGRESS.md` (este archivo) — qué está hecho/pendiente.
3. `AGENTS.md` / `CLAUDE.md` — reglas del repo.
4. El código (es la verdad final; los docs lo describen).

## Comandos de verificación
- `npm run verify` = `lint → typecheck → test → build` (todo debe pasar).
- `npm run test` para tests rápidos. `npm run eval` pega a Claude (cuesta plata, no en CI).

---

## Estado por fase

| # | Fase | Estado |
|---|---|---|
| 0 | Discovery + arquitectura + docs | ✅ hecho |
| 1 | Migración `0009` (conversations, messages, leads.contact/engage, RPCs, settings) | ✅ escrita (falta aplicar a la DB) |
| 2 | Tipos (`types/autopilot.ts`) + helpers DB (`lib/db/conversations.ts`) | ✅ |
| 3 | Cerebro IA del closer (`lib/ai/agent.ts`) + playbook settings | ✅ |
| 4 | Capa de canales: interfaz+registry ✅ · adapters (wa/tg/bsky/reddit) | ⏳ delegado |
| 5 | Motor de conversación (`lib/conversation/engine.ts`) | ✅ |
| 6 | Rutas: `/api/engage`, `/api/inbound/*`, `/api/followup` + contacto en poll | ⏳ delegado |
| 7 | Worker de Telegram (`worker/`) para Railway | ⏳ delegado |
| 8 | Dashboard premium (overview, conversations, thread, playbook/autopilot config) | ⏳ delegado |
| 9 | Cron wiring + env + `.env.example` + README/deploy | ⏳ delegado |
| 10 | Tests + verificación (lint/typecheck/test/build) | ✅ verde |

**Build note:** `next build` necesita las env vars presentes (igual que v1: el módulo
`lib/env.ts` valida al importar). En CI/Vercel se proveen; en local se exporta un set
dummy de formato válido para verificar. Compila, typechequea y buildea OK.

## Qué quedó construido (resumen)
- **DB**: migración `0009_conversations.sql` — tablas `conversations`/`messages`,
  columnas de contacto/engage en `leads`, RPCs de claim, triggers (contadores +
  auto-encolado a engage), settings del autopilot. (Falta APLICARLA a la DB.)
- **IA**: `lib/ai/agent.ts` — el closer (tool use forzado + prompt caching).
- **Motor**: `lib/conversation/engine.ts` — engage/ingest/turn/followup/handoff.
- **Canales**: `lib/channels/*` — whatsapp (listo), telegram (vía worker), bluesky,
  reddit (gated). Registry + adapters.
- **Rutas**: `/api/engage`, `/api/inbound/{whatsapp,telegram,poll}`, `/api/followup`.
- **Worker**: `worker/` — servicio Node para Railway (puente MTProto ↔ app).
- **Dashboard**: `/overview`, `/conversations`, `/conversations/[id]` (chat + composer
  + toggle autopilot), `/config` con tabs Playbook y Autopilot (switch maestro).
- **Infra**: `supabase/cron.sql` (+engage/followup/inbound), `.env.example`,
  `docs/DEPLOY.md`, README.

## Limitaciones conocidas / próximas mejoras
- **WhatsApp como primer contacto**: ninguna fuente entrega teléfonos, así que las
  conversaciones de WhatsApp hoy se inician a mano o llegan como entrante. Falta la
  **migración de canal** (el agente detecta un teléfono en una charla de Telegram/
  Bluesky y propone seguir por WhatsApp). Pendiente.
- **Telegram**: para DMear individuos hay que sondear **grupos** (no canales
  broadcast). La fuente emite `contact` sólo cuando hay remitente individual.
- **Webhook de Evolution con header**: si Evolution no permite headers custom en el
  webhook, hay que pasar el secreto por query/otra vía (ver DEPLOY.md).
- **Tipos generados**: `types/database.ts` no incluye las tablas nuevas (el cliente
  es sin tipar; se usan tipos propios en `types/autopilot.ts`). Al regenerar desde la
  DB aparecerán solas.

## Para ACTIVAR (ver docs/DEPLOY.md, en orden)
1. Aplicar `supabase/migrations/0009_conversations.sql` a la DB del radar.
2. Setear `WEBHOOK_SECRET` en Vercel.
3. Telegram: `TELEGRAM_SESSION` + deploy `worker/` a Railway + `TELEGRAM_WORKER_URL`.
4. Bluesky: `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD`.
5. Webhook de Evolution → `${APP_URL}/api/inbound/whatsapp`.
6. Re-correr `supabase/cron.sql` con la URL de prod.
7. Cargar el Playbook en `/config` y prender `outreach_enabled`.

---

## Hecho y verificado
- **Discovery completo** del sistema v1 (pipeline detección→clasificación→aviso).
- **Arquitectura v2** decidida y escrita (`docs/ARCHITECTURE.md`).
- `npm install` OK (node_modules presente).

## Próxima tarea exacta
Escribir `supabase/migrations/0009_conversations.sql` según §4 de ARCHITECTURE.md
y aplicarla (MCP Supabase `execute_sql` / `apply_migration` sobre el proyecto del
radar). Después regenerar/extender `types/database.ts`.

## Decisiones tomadas (no re-litigar)
- Canal-agnóstico; canales vivos: **telegram, bluesky, whatsapp**; reddit gated.
- Worker chiquito en **Railway** solo para Telegram (MTProto no vive en serverless).
- Se mantiene **Anthropic SDK directo** (no Vercel AI SDK) por consistencia con v1.
- **Autopilot global arranca APAGADO** (`outreach_enabled=false`): modo shadow
  hasta que Manuel lo prenda desde el panel.
- Reuso del patrón de claims resilientes y del estilo de rutas de v1.

## Inputs pendientes del usuario (Manuel) — para activar en producción
- [ ] Proyecto Supabase del radar: ¿cuál es? (aplicar migraciones ahí).
- [ ] `WEBHOOK_SECRET` (generar con `openssl rand -hex 32`).
- [ ] Telegram: `TELEGRAM_API_ID/HASH` + correr `scripts/telegram-login.ts` para `TELEGRAM_SESSION`. Deploy del worker a Railway → `TELEGRAM_WORKER_URL`.
- [ ] Bluesky: `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` (app password, no la real).
- [ ] (Opcional) Reddit: `REDDIT_CLIENT_ID/SECRET/REFRESH_TOKEN`.
- [ ] Configurar webhook de Evolution → `{APP_URL}/api/inbound/whatsapp` con `x-webhook-secret`.
- [ ] Cargar el **Playbook** (oferta, rango de precios, tono) desde `/config`.

## Gotchas / notas
- `node_modules/next/dist/docs` NO existe en este install → la regla de AGENTS.md
  de "leer los docs bundleados" no aplica literal; la referencia es el código v1
  que ya compila en Next 16.2.6. Mirror de patrones existentes.
- Next 16: middleware se llama `proxy.ts`. Route handlers: `export const dynamic`,
  `maxDuration`, `after()` de `next/server`.
- Migraciones se aplican vía MCP de Supabase (no hay supabase CLI local / config.toml).
- `claimed_at` en leads lo comparten llm/notify; engage usa `engage_claimed_at` aparte.

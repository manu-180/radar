# Radar Autopilot — Arquitectura

> Evolución del **Lead Detector** (detección → aviso al dueño) a un **closer
> autónomo**: detecta el lead, lo contacta solo, mantiene toda la conversación
> con IA y te la entrega cuando el cliente pide un boceto/propuesta. Más un
> **dashboard de comando premium** para ver y controlar todo.

Este documento es la **fuente de verdad** de la arquitectura. Si algo del chat
contradice esto, vale esto. El estado de avance vive en [`PROGRESS.md`](./PROGRESS.md).

---

## 1. Qué había y qué agregamos

**Antes (v1 — Lead Detector):**
`poll fuentes → pre-filtro keywords → clasifica (Claude) → guarda → avisa al
dueño por WhatsApp con un "suggested_reply" para copiar a mano.` Termina en
"avisar al dueño".

**Ahora (v2 — Autopilot):** se agrega una capa nueva **después** de clasificar:

```
                                   ┌─────────────── v1 (intacto) ───────────────┐
 poll fuentes → pre-filtro → clasifica (hiring/maybe/noise + score + contacto)
                                   └───────────────────────┬────────────────────┘
                                                           │  lead califica + tiene canal de contacto
                                                           ▼
   ┌──────────────────────────── v2 Autopilot ────────────────────────────┐
   │  ENGAGE  → crea conversación + manda la 1ª oferta en el canal del lead │
   │  TURN    → por cada mensaje entrante, el agente IA responde solo       │
   │  FOLLOW  → si el lead no contesta, reengancha (con tope)               │
   │  HANDOFF → cuando pide boceto/propuesta → te lo pasa a vos             │
   └───────────────────────────────────────────────────────────────────────┘
```

La detección/clasificación de v1 **no se toca**: sigue alimentando leads y
avisándote. Autopilot consume los leads ya clasificados que califican.

---

## 2. La decisión central: ¿en qué canal se conversa?

Una conversación de ida y vuelta necesita un **canal donde se pueda mandar un
mensaje a esa persona**. No todas las fuentes lo permiten. Esto define todo:

| Fuente (detección) | ¿Se puede contactar al autor? | Canal de conversación |
|---|---|---|
| **Telegram** (grupos) | Sí — DM al autor vía MTProto (si su privacidad lo permite) | **telegram** ⭐ |
| **Bluesky** | Sí — reply público + DM (AT Protocol, gratis) | **bluesky** ⭐ |
| Cualquiera + teléfono | Sí, si el lead comparte un número | **whatsapp** (Evolution, ya andaba) |
| **Reddit** | Técnicamente sí (reply/DM) pero **alto riesgo de ban** | **reddit** (gated, aprobación manual) |
| Hacker News, RSS, Freelancer (sin API de mensajería) | No hay handle para escribirle | — (queda como lead → te avisa, no se auto-engancha) |

**Conclusión de diseño:**
- Canales de outreach **vivos**: `telegram`, `bluesky`, `whatsapp`.
- `reddit`: soportado pero **autopilot OFF por defecto** (vos aprobás cada
  envío desde el panel). Auto-DMear a desconocidos en Reddit banea cuentas.
- Fuentes sin canal → `contact_channel = null` → no se auto-enganchan; siguen
  siendo leads que te avisan (comportamiento v1). Vos podés iniciar una
  conversación a mano desde el panel si conseguís un contacto.

El motor de conversación es **agnóstico al canal**: el mismo cerebro IA maneja
Telegram, Bluesky o WhatsApp. Agregar un canal = un adapter nuevo.

---

## 3. Por qué hace falta un worker en Railway (y nada más)

Vercel es **serverless**: las funciones viven milisegundos y mueren. No pueden
sostener la conexión persistente de Telegram (MTProto) ni escuchar DMs entrantes
en tiempo real. Por eso:

- **Worker de Telegram en Railway** (`worker/`): un proceso Node chiquito y
  siempre prendido que (a) mantiene la sesión de Telegram, (b) escucha DMs
  entrantes y los reenvía al webhook de la app en Vercel, (c) expone un
  `POST /send` que la app llama para mandar un mensaje. ~150 líneas. Es un
  **puente de transporte**: toda la lógica (IA, DB, decisiones) vive en Vercel.
- **Evolution API** (WhatsApp) ya corre en Railway (infra de "senders"
  existente). Manda webhooks de entrantes → `/api/inbound/whatsapp`.
- **Bluesky y Reddit** hablan HTTP plano → se manejan directo desde Vercel
  (envío en línea, entrantes por polling del cron). No necesitan worker.

**Costos (objetivo ≤ US$20–30/mes, idealmente menos):**

| Servicio | Plan | Costo |
|---|---|---|
| Vercel | Hobby (free) | $0 |
| Supabase | Free (pg_cron incluido, 500MB) | $0 |
| Railway | Worker Telegram + Evolution (~0.5–1GB) | ~$5/mes |
| Anthropic | Pay-as-you-go (Haiku, con prompt caching) | ~$2–10/mes según volumen |
| Telegram / Bluesky / Reddit APIs | — | $0 |
| **Total** | | **~$5–15/mes** |

---

## 4. Modelo de datos (migración `0009`)

Tablas nuevas + columnas en `leads`. RLS cerrado (igual que v1: solo service role).

### `leads` — columnas nuevas (cómo contactar + cola de engage)
- `contact_channel text` — mejor canal para escribirle (`null` = no contactable).
- `contact_key text` — clave de ruteo en ese canal (phone digits / tg user id / did / username).
- `contact_ref jsonb` — direccionamiento completo, opaco por canal (ej. tg `access_hash`).
- `contact_handle text` — display para el panel (`@user`, `+54…`).
- `engage_status text default 'none'` — `none | pending | engaging | engaged | skipped`.
- `engage_claimed_at timestamptz` — claim resiliente (separado de `claimed_at` de llm/notify).
- `engaged_at timestamptz`.

`engage_status` lo setea el paso de clasificación: `pending` si el lead califica
(regla `engage_rule`) **y** tiene `contact_channel`; `skipped` si califica pero
no hay canal; `none` si no califica.

### `conversations` — una por lead+canal
- `id`, `lead_id → leads(id)`, `channel`.
- `contact_key text` + `contact_ref jsonb` + `contact_handle text`.
- **`unique (channel, contact_key)`** → ruteo de entrantes O(1) y dedup de conversaciones.
- `status` — `pending_outreach | active | awaiting_reply | snoozed | wants_draft | handed_off | won | lost | disqualified | paused | failed`.
- `stage` — `outreach | greeted | discovery | offer | negotiation | scheduling | draft_requested | closed`.
- `interest_level int (0–100)` — lo actualiza el agente en cada turno.
- `autopilot boolean default true` — el switch que pediste (por conversación).
- `message_count`, `outbound_count`.
- `last_inbound_at`, `last_outbound_at`, `next_action_at` (follow-up programado).
- `claimed_at timestamptz` — claim del turno (un turno por conversación a la vez).
- `summary text` — resumen vivo para compactar contexto en charlas largas.
- `last_error text`, `meta jsonb`, `created_at`, `updated_at`.

### `messages` — cada mensaje de cada conversación
- `id`, `conversation_id → conversations(id) on delete cascade`.
- `direction` — `inbound | outbound`.
- `role` — `lead | agent | owner | system` (owner = vos a mano; system = eventos).
- `body text`.
- `channel_message_id text` + **`unique (conversation_id, direction, channel_message_id)`** → dedup de entrantes.
- `status` — `received | queued | sending | sent | delivered | failed`.
- `error`, `ai_model`, `input_tokens`, `output_tokens`, `ai_cost_usd`, `interest_level` (snapshot).
- `created_at`, `sent_at`.

### RPCs (patrón claim resiliente de v1: `FOR UPDATE SKIP LOCKED` + claim viejo)
- `claim_leads_to_engage(batch_size, cats, min_score) → setof leads`.
- `claim_conversations_due(batch_size) → setof conversations` — para follow-ups (`next_action_at <= now()`).
- `claim_conversation_for_turn(conv_id) → conversations` — toma una conversación para correr un turno (evita dobles respuestas).

### `settings` — claves nuevas
- `outreach_enabled` (bool, default `false` — arranca apagado por seguridad).
- `engage_rule` `{ categories, minScore }` (default = `notify_rule`).
- `channel_autopilot` `{ telegram:true, bluesky:true, whatsapp:true, reddit:false }`.
- `outreach_daily_cap` (int, default 20 — anti-ban global).
- `agent_playbook` (ver §6).
- `agent_max_messages` (int, default 12 — tope de turnos del agente antes de handoff forzado).
- `followup_policy` `{ delaysHours:[24,72], maxFollowups:2 }`.

---

## 5. Flujo end-to-end

### ENGAGE — primer contacto automático
`POST /api/engage` (cron, offset propio):
1. `claim_leads_to_engage(...)` con `engage_rule`.
2. Por lead: chequea `outreach_enabled`, `channel_autopilot[canal]`, cap diario.
3. Crea `conversation` (`pending_outreach`), genera el 1er mensaje con el agente
   (modo *opener*, usando `suggested_reply` como semilla), lo manda por el
   adapter del canal, guarda el `message`, pasa la conversación a `awaiting_reply`
   y el lead a `engaged`.
4. Ritmo humano + jitter entre envíos; aislamiento de fallos por lead.

### TURN — el agente conversa
Entrantes llegan por:
- `POST /api/inbound/whatsapp` — webhook de Evolution.
- `POST /api/inbound/telegram` — lo postea el worker de Railway.
- `POST /api/inbound/poll` (cron) — Bluesky/Reddit (sin webhook): lista DMs/replies nuevos.

Todos terminan en **`runConversationTurn(conversationId)`** (`lib/conversation/engine.ts`):
1. Guarda el mensaje entrante (dedup por `channel_message_id`).
2. Si `autopilot` OFF (conv o canal) → no responde; marca `awaiting_owner` y te avisa.
3. Si ON → claim del turno → arma contexto (historial + lead + playbook + resumen)
   → llama a Claude (tool use forzado) → decide:
   - `reply` → manda mensaje, actualiza `interest_level`/`stage`.
   - `handoff` → `status='wants_draft'`, te avisa por WhatsApp con el contexto.
   - `wait` → no hay nada que decir todavía.
   - `disqualify` → `status='disqualified'`.
4. Re-chequea si entró un mensaje nuevo durante el turno; si sí, loopea.

### FOLLOW-UP — reengancha si se enfría
`POST /api/followup` (cron): `claim_conversations_due()` → genera un reengance
suave según `followup_policy`, respetando `agent_max_messages` y autopilot.

### HANDOFF — te lo entrega
Cuando el lead pide boceto/propuesta/presupuesto formal o quiere hablar con una
persona, el agente hace `handoff`: la conversación queda `wants_draft`, se te
manda un WhatsApp con el resumen + link al hilo en el panel, y el agente deja de
responder (espera que tomes vos).

---

## 6. El cerebro IA (`lib/ai/agent.ts`)

Mismo estilo que el clasificador v1: **Anthropic SDK directo** (no Vercel AI SDK,
por consistencia con el código existente), **tool use forzado**, **prompt
caching** sobre el system prompt estático.

- **System prompt (cacheado):** persona del freelancer, *playbook* (oferta,
  rango de precios, qué ofrecemos, tono argentino), reglas de handoff, hardening
  anti prompt-injection (el texto del lead es DATO).
- **Variable:** transcript de la conversación + resumen + datos del lead.
- **Salida (tools):**
  - `reply(message, interest_level, stage, next_action)`
  - `handoff(reason, interest_level)`
  - `disqualify(reason)`
- **Guardrails (innegociables):**
  - Nunca promete precios fuera del rango configurado; si lo presionan, da el
    rango y ofrece confirmártelo a vos.
  - Nunca promete plazos; junta requerimientos.
  - Objetivo = que pidan un boceto/propuesta → **handoff** (no intenta cerrar
    plata ni mandar el boceto solo).
  - Tope de mensajes (`agent_max_messages`) → handoff forzado (evita loops y costo).
  - Idioma espejo del lead (default español rioplatense).

---

## 7. Canales (`lib/channels/*`) — patrón registry como las fuentes

```ts
interface ChannelAdapter {
  channel: string;
  // Manda un mensaje saliente. Devuelve el id del proveedor (o null).
  send(conv: ConversationRef, text: string): Promise<{ id: string | null }>;
  // Parseo de un webhook entrante (si el canal usa webhook).
  parseInbound?(payload: unknown): InboundMessage | null;
  // Polling de entrantes (si el canal no tiene webhook): Bluesky/Reddit.
  pollInbound?(): Promise<InboundMessage[]>;
}
```

- `whatsapp.ts` — envuelve `sendWhatsApp` (al número del lead). Entrante: webhook Evolution.
- `telegram.ts` — `send` llama al `POST /send` del worker de Railway. Entrante: el worker postea a `/api/inbound/telegram`.
- `bluesky.ts` — AT Protocol con app-password: reply público / DM. Entrante: polling.
- `reddit.ts` — OAuth script app: reply / DM. **Gated** (autopilot off por defecto).

---

## 8. Dashboard premium (`app/(dashboard)`)

Server components + Tailwind v4 (se mantiene el stack; se sube el nivel visual).
Protegido por `proxy.ts` (sin cambios al modelo de auth).

- **`/` (Overview):** KPIs (conversaciones activas, esperando respuesta, handoffs
  pendientes, leads del día, costo IA), embudo, actividad reciente.
- **`/conversations`:** lista de charlas con canal, handle, stage, **medidor de
  interés**, último mensaje, estado, switch de autopilot.
- **`/conversations/[id]`:** hilo tipo chat (burbujas in/out), composer para
  responder a mano, toggle de autopilot, panel lateral con datos del lead +
  timeline + costo. Botones: marcar ganado/perdido, retomar, snooze.
- **`/leads`, `/metrics`, `/config`:** se mantienen, con el restyle y métricas de
  conversación agregadas.
- **`/config`:** nuevo tab **Playbook** (persona, oferta, rango de precios, tono,
  triggers de handoff) + **Autopilot** (global on/off, por canal, cap diario,
  política de follow-up) + setup de canales (estado del worker, instancia WA, etc).

---

## 9. Cron (`supabase/cron.sql`) — etapas desacopladas, idempotentes

A los jobs de v1 (`poll :00/20/40`, `process :05/25/45`, `notify :12/32/52`,
`health :30`) se agregan:
- `engage` — `:08/28/48` (después de notify; toma leads ya clasificados).
- `followup` — cada hora `:15` (reenganches que vencieron).
- `inbound-poll` — cada 5 min (Bluesky/Reddit entrantes; barato).

---

## 10. Seguridad y robustez

- Webhooks entrantes protegidos por secreto (`x-webhook-secret`, timing-safe) —
  `WEBHOOK_SECRET` nuevo. El worker y Evolution lo mandan.
- Claims resilientes en todo (leads, conversaciones) → nada queda colgado si una
  función muere.
- Dedup de entrantes por `channel_message_id` → un webhook reintentado no duplica.
- Aislamiento de fallos por item en cada lote.
- Anti-ban: cap diario, jitter entre envíos, tope de mensajes por conversación,
  Reddit gated, autopilot global apagado por defecto (arrancás en modo "shadow":
  detecta y prepara, vos prendés cuando querés).
- Costo IA acotado: Haiku + caching; tope de turnos; Sonnet solo si se necesita.

---

## 11. Variables de entorno nuevas
- `WEBHOOK_SECRET` — protege los webhooks entrantes (mín. 16). **Requerida** para outreach.
- `TELEGRAM_WORKER_URL` — URL pública del worker en Railway (para `POST /send`). Opcional (sin ella, canal telegram inerte).
- `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` — opcionales (canal bluesky).
- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` + `REDDIT_REFRESH_TOKEN` — opcionales (canal reddit).
- (worker) `TELEGRAM_API_ID/HASH/SESSION`, `APP_URL`, `WEBHOOK_SECRET`.

Patrón igual a v1: si falta lo opcional, ese canal queda inerte pero la app arranca.

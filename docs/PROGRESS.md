# Radar Autopilot — Progreso

> Estado vivo del trabajo. La arquitectura está en [`ARCHITECTURE.md`](./ARCHITECTURE.md).
> Una sesión nueva debe poder reconstruir TODO desde acá + el repo, sin el chat.

**Última actualización:** 2026-06-13 (sesión 2: hardening + verificación del worker)

## ✅ ESTADO: construido y verificado (falta activar con credenciales)
Todo el código de v2 está escrito e integrado. Verificación local en verde:
`tsc --noEmit` ✓ · `eslint` ✓ · `vitest` 111 tests ✓ · `next build` ✓.
**Worker** (Telegram, Railway): `npm install` ✓ · `tsc` ✓ · código revisado ✓.
Lo único pendiente es **activación** (credenciales + aplicar migración + prender el
switch), documentado en [`DEPLOY.md`](./DEPLOY.md). El sistema arranca en modo
**shadow** (`outreach_enabled=false`): detecta y prepara, no contacta a nadie.

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

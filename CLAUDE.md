# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build
npm run lint         # ESLint (use this, NOT next lint — deprecated in Next 16)
npm run typecheck    # tsc --noEmit
npm test             # Vitest (all tests)
npx vitest run test/prefilter.test.ts   # Run a single test file
npm run eval         # Manual classifier eval against Claude API (costs money, skip in CI)
```

CI runs lint → typecheck → test → build in that order. All must pass.

## Architecture

This is an autonomous lead qualification + sales pipeline. External platforms are continuously polled; posts are filtered, classified by Claude, then the system autonomously opens and drives conversations with prospects via WhatsApp, Telegram, Bluesky, or Reddit.

### Pipeline stages (database-driven, no direct calls between stages)

```
[pg_cron] → /api/cron/dispatch
               └─ fans out via Next.js after() to /api/poll/[source]  (every 20 min)
                      └─ fetches items → pre-filter → persist leads
           → /api/process   (staggered +5 min)
                      └─ claims pending leads → classifyLead (Haiku, escalates to Sonnet) → mark done/skipped
           → /api/notify    (every 60 min)
                      └─ claims qualified leads → sendWhatsApp to owner
           → /api/engage    (v2)
                      └─ opens conversation → sends first message via channel adapter
           → /api/followup  (v2)
                      └─ re-engages silent conversations
```

Inbound messages arrive via webhooks (`/api/inbound/whatsapp`, `/api/inbound/telegram`) or polling (`/api/inbound/poll`), then flow through `lib/conversation/engine.ts` → `runAgent` → send reply.

Stage coordination is entirely via DB columns (`llm_status`, `notify_status`, `conversations.status`). Stages claim work using Postgres advisory locks + `FOR UPDATE SKIP LOCKED` RPCs to prevent races. Stale claims auto-release after 5 min.

### Registry pattern (sources + channels)

Both adapters use the same side-effect registration pattern:

```
lib/sources/index.ts  → imports each adapter → adapter calls registerSource() at module load
lib/channels/index.ts → imports each adapter → adapter calls registerChannel() at module load
```

To add a source: implement `SourceAdapter` in `lib/sources/`, import it in `lib/sources/index.ts`.  
To add a channel: implement `ChannelAdapter` in `lib/channels/`, import it in `lib/channels/index.ts`.

### Authentication

**Dashboard** (`proxy.ts` middleware): Cookie `ld_session` = `<issuedAt_ms>.<HMAC-SHA256-base64url>`. Validated by signature + 30-day TTL. Logic in `lib/auth.ts`.

**API routes** (cron endpoints): `x-cron-secret` header checked via `verifyCronSecret()` in `lib/security.ts` using timing-safe comparison. Never use `===` to compare secrets.

### Database access

Always use the admin client (`lib/supabase/admin.ts → getAdminClient()`) for server-side DB operations — it uses the service role key and bypasses RLS. The anon key is for browser-side only. RLS is enabled on all tables.

### AI integration

`lib/ai/classifier.ts` — single forced tool-use call, system prompt cached (~1500 tokens). Haiku 4.5 by default; if `score === 'maybe'` or low confidence, re-runs with Sonnet 4.6.

`lib/ai/agent.ts` — multi-turn agent with structured output (`action: send | handoff | schedule_followup | pause`). Receives last 16 messages as context. Transitions conversation state machine.

Token costs tracked per call in `lib/ai/pricing.ts`; cache reads cost 10% of input price.

### Environment

All env vars go through `lib/env.ts` (Zod schema). Access via the `env` export — never `process.env` directly. The schema distinguishes required vs. optional with defaults.

### Key gotchas

- `after()` (Next.js) is used in `/api/cron/dispatch` to fan out polls without blocking the HTTP response. Do not `await` inside `after()` chains for side effects you care about.
- `lib/sources/*/` adapters update their cursor in `sources.config` (JSONB) after each successful poll.
- Content dedup uses `content_hash` (SHA-256 of normalized content) as primary key; `(source, external_id)` is secondary. `ON CONFLICT DO NOTHING` covers both.
- `runs` table tracks every cron execution — always call `startRun`/`finishRun` in API routes.
- Telegram requires a separate Railway worker (MTProto bridge); the channel adapter talks to it via HTTP.

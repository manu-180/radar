# Lead Detector

Monitorea plataformas online (Hacker News, Reddit, Bluesky, Freelancer.com, feeds RSS,
Telegram, Discord) buscando gente que necesita contratar un developer web/apps. Filtra los
posts con IA (Claude) y avisa al dueño por WhatsApp con un mensaje sugerido listo para
responder.

## Stack

- **Next.js** (App Router, TypeScript) — frontend y API routes
- **Supabase** — base de datos Postgres
- **Claude API** (`@anthropic-ai/sdk`) — filtrado inteligente de leads
- **Wassenger** — notificaciones por WhatsApp
- **Vercel** — hosting y cron jobs
- **Vitest** + **tsx** — tests unitarios y scripts

Todo el stack corre en free tier.

## Estructura

- `app/` — rutas y páginas (App Router)
- `lib/` — lógica de negocio (`sources/`, `filter/`, `ai/`, `notify/`, `db/`, `supabase/`)
- `scripts/` — scripts sueltos que se corren con `tsx`
- `supabase/migrations/` — migraciones SQL
- `test/` — tests unitarios (Vitest)
- `types/` — tipos compartidos

## Scripts

- `npm run dev` — levanta el entorno de desarrollo
- `npm run build` — build de producción
- `npm test` — corre la suite de tests
- `npm run typecheck` — chequeo de tipos (`tsc --noEmit`)
- `npm run verify` — corre lint, typecheck, tests y build en orden

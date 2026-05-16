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

## Scheduling autónomo

El sistema corre solo, sin intervención humana: un cron dispara cada 20 min las
tres etapas del pipeline. Se usa **Supabase Cron** (`pg_cron`), no Vercel Cron —
el plan Hobby de Vercel solo permite frecuencia diaria, inservible para sondear
cada 20 min. `pg_cron` corre dentro de Postgres, soporta frecuencia sub-minuto y
dispara HTTP con `pg_net`. Gratis.

Los jobs se definen en `supabase/cron.sql`, un script **idempotente** (desagenda
y vuelve a agendar): se puede re-correr sin duplicar jobs. Cada job hace un
`net.http_post` a una ruta `/api/...`, con el header `x-cron-secret` resuelto en
cada corrida desde **Supabase Vault** (secreto `cron_secret`) — nunca queda en
texto plano en `cron.job`.

| Job                     | Cron             | Ruta                  |
| ----------------------- | ---------------- | --------------------- |
| `lead-detector-poll`    | `*/20 * * * *`   | `/api/cron/dispatch`  |
| `lead-detector-process` | `5-59/20 * * * *`| `/api/process`        |
| `lead-detector-notify`  | `12-59/20 * * * *`| `/api/notify`        |
| `lead-detector-health`  | `30 * * * *`     | `/api/health/check`   |

Los jobs apuntan a la URL base definida en la variable `app_url` de
`supabase/cron.sql` (la misma idea que `APP_URL`). Hoy es `http://localhost:3000`;
en el paso de deploy (33) se **re-corre `cron.sql`** cambiando `app_url` por la
URL de producción de Vercel.

Las extensiones `pg_cron` y `pg_net` se habilitan en la migración
`0004_cron_extensions`.

## Monitoreo de salud

Un sistema autónomo necesita un "monitoreo del monitor": si deja de funcionar,
nadie lo está mirando. El monitoreo tiene **tres capas**, cada una cubre lo que
la anterior no puede ver:

1. **Self-check interno** — `lead-detector-health` (cron, cada hora) dispara
   `POST /api/health/check`, que evalúa fallas *parciales*: no hubo polls
   recientes, una fuente acumula polls fallidos, la cola de IA se estancó, las
   notificaciones fallan, o el propio `pg_cron` tuvo corridas fallidas (lo lee
   de `cron.job_run_details` vía el RPC `health_cron_failures`). Si algo está
   roto, manda un WhatsApp al dueño. Tiene **anti-spam**: guarda en `settings`
   (`health_last_alert`) la firma del problema y sólo re-avisa si la firma
   cambia o pasa un cooldown de 6 h; al recuperarse avisa una vez y limpia la
   firma.
2. **Lectura del cron** — la capa 1 cubre que el cron de Postgres falle, algo
   que el cron mismo no puede reportar porque no llega a la app.
3. **Monitor externo de uptime** — cubre la **caída total**: si Vercel está
   abajo, las capas 1 y 2 tampoco corren. Hay que dar de alta un monitor de
   uptime gratuito (por ejemplo [UptimeRobot](https://uptimerobot.com),
   [Better Stack](https://betterstack.com) o [Cron-job.org](https://cron-job.org))
   que haga un ping HTTP a **`${APP_URL}/api/health`** cada ~5 min. Ese endpoint
   es público (sin secreto sólo devuelve `{ status }`) y responde **503** cuando
   el sistema está caído, así que el monitor alerta por mail/Telegram solo.

## Credenciales de fuentes opcionales

Algunas fuentes requieren credenciales (ver `.env.example`, sección _Opcionales_).
Si faltan, esa fuente queda inerte pero la app arranca igual.

### `FREELANCER_OAUTH_TOKEN` — Freelancer.com

La fuente Freelancer.com usa la API oficial (gratis) de proyectos activos, que
exige un token OAuth personal de la cuenta del dueño. Un token de solo lectura
alcanza para la búsqueda. Para obtenerlo:

1. Iniciá sesión en [freelancer.com](https://www.freelancer.com) con la cuenta del dueño.
2. Entrá a la sección de desarrolladores / API: <https://developers.freelancer.com>.
3. Creá una aplicación y generá un **OAuth access token** personal.
4. Pegá el token en `FREELANCER_OAUTH_TOKEN` en tu `.env.local`.

El token viaja en el header `freelancer-oauth-v1` de cada request. Sin él, la
fuente `freelancer` devuelve `[]` sin error.

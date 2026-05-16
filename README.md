# Lead Detector — Runbook

Monitorea plataformas online (Hacker News, Reddit, Bluesky, Freelancer.com, feeds
RSS, y —pendientes de adaptador— Telegram y Discord) buscando gente que necesita
contratar un developer web/apps. Pre-filtra el ruido por keywords, clasifica los
candidatos con IA (Claude) y le avisa al dueño por WhatsApp con un mensaje
sugerido listo para responder. Corre **solo, sin intervención humana**.

Este README es el **runbook**: cómo está armado el sistema, cómo operarlo, cómo
verificarlo y qué hacer cuando algo falla.

---

## 1. Arquitectura

El sistema es un **pipeline de tres etapas desacopladas** más una de monitoreo.
Cada etapa es una ruta API idempotente, protegida por el header `x-cron-secret`,
que un cron externo dispara en su propio horario. Ninguna etapa llama a la
siguiente directamente: se comunican por el estado en la base (las colas
`llm_status` y `notify_status` de la tabla `leads`).

```
                    ┌──────────────── Supabase Cron (pg_cron) ────────────────┐
                    │  poll :00/:20/:40   process :05/:25/:45   notify :12/... │
                    └────┬───────────────────┬────────────────────┬───────────┘
                         ▼                   ▼                    ▼
   POST /api/cron/dispatch     POST /api/process        POST /api/notify
        │                          │                        │
        │ fan-out por fuente       │ reclama leads `pending` │ reclama leads
        ▼                          │ los clasifica con Claude│ que califican
   POST /api/poll/<slug>           │ → `done` + categoría    │ → WhatsApp al
        │ adapter.fetchItems()     │ + score + llm_cost_usd  │   dueño
        │ pre-filtro keywords      ▼                         ▼
        ▼                     tabla `leads`             Wassenger API
   tabla `leads` (`pending`)   (cola notify)         tabla `notifications`
```

**Etapa 1 — Polling.** `POST /api/cron/dispatch` lee las fuentes habilitadas y,
en `after()`, dispara un `POST /api/poll/<slug>` por cada una (fan-out en
paralelo, cada poll con su propio presupuesto de 300 s). Cada `/api/poll/<slug>`
le pide items nuevos al adaptador de esa fuente (polling incremental por
`cursor`), corre el **pre-filtro determinístico de keywords** y persiste los
leads: los que pasan el pre-filtro quedan `llm_status='pending'`, el resto
`'skipped'`. El dedup es por `content_hash` / `external_id`.

**Etapa 2 — Clasificación.** `POST /api/process` reclama un lote de leads
`pending` (`claim_pending_leads`, con `FOR UPDATE SKIP LOCKED` — sin condiciones
de carrera), los clasifica con Claude y persiste `category`, `score`, `reason`,
`suggested_reply` y `llm_cost_usd`. Usa **Haiku 4.5** por defecto y **escala a
Sonnet 4.6** los casos ambiguos (`maybe`). Si quedan leads `pending`, la ruta se
re-dispara a sí misma para drenar el backlog sin esperar al cron.

**Etapa 3 — Notificación.** `POST /api/notify` reclama los leads ya clasificados
que cumplen la regla de notificación (`claim_leads_to_notify`), arma el mensaje y
lo manda por WhatsApp vía Wassenger, con una espera de 3–5 s entre envíos. Un
tope por corrida (`max_notifications_per_run`) evita ráfagas.

**Monitoreo.** Tres capas — ver [§9](#9-monitoreo-de-salud).

Cada corrida de cada etapa abre y cierra una fila en `runs` (con `kind`,
`status`, `items_found`, `items_processed`, `error`), que es la traza operativa
del sistema.

### Tablas de Postgres (Supabase)

| Tabla           | Para qué                                                            |
| --------------- | ------------------------------------------------------------------- |
| `sources`       | Una fila por fuente: `enabled`, `config` (JSON), `cursor` de polling |
| `keywords`      | Keywords del pre-filtro (`include`/`exclude`, por idioma)            |
| `leads`         | Cada item detectado, con su clasificación y el estado de las colas  |
| `runs`          | Traza de cada corrida de poll/process/notify/health                 |
| `notifications` | Registro de cada WhatsApp enviado (o fallado)                       |
| `settings`      | Config manejada por datos (regla de notificación, perfil, etc.)     |

El esquema se versiona en `supabase/migrations/` (`0001`–`0005`).

---

## 2. Stack

- **Next.js 16** (App Router, TypeScript) — frontend y API routes
- **Supabase** — Postgres + `pg_cron`/`pg_net` para el scheduling
- **Claude API** (`@anthropic-ai/sdk`) — clasificación de leads (Haiku 4.5 / Sonnet 4.6)
- **Wassenger** — notificaciones por WhatsApp
- **Vercel** — hosting de la app y de las rutas API
- **Vitest** + **tsx** — tests unitarios y scripts

Todo el stack corre en free tier salvo la API de Claude (ver [§8 Costos](#8-costos)).

---

## 3. Estructura del repo

- `app/` — rutas y páginas (App Router). `app/api/` son los endpoints; `app/(dashboard)/` el panel
- `lib/` — lógica de negocio: `sources/` (adaptadores), `filter/`, `ai/`, `notify/`, `db/`, `supabase/`
- `scripts/` — scripts sueltos que se corren con `tsx` (tests manuales de fuentes, `eval-classifier`)
- `supabase/migrations/` — migraciones SQL; `supabase/cron.sql` — los jobs del scheduler
- `test/` — tests unitarios (Vitest) y fixtures
- `types/` — tipos compartidos (incluido `database.ts`, generado del esquema)

---

## 4. Variables de entorno

Copiá `.env.example` a `.env.local` y completá los valores. `lib/env.ts` valida
`process.env` con Zod al arrancar: si falta una **requerida**, la app no levanta
y el error la nombra. Las **opcionales** pueden faltar — la fuente que dependa de
ellas queda inerte, pero la app arranca igual.

### Requeridas

| Variable                        | Para qué                                                            |
| -------------------------------- | ------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`       | URL del proyecto Supabase (pública)                                 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`  | Anon key de Supabase (pública)                                      |
| `SUPABASE_SERVICE_ROLE_KEY`      | Service role key — bypassa RLS. **Secreta, solo servidor**          |
| `ANTHROPIC_API_KEY`              | API key de Claude                                                   |
| `WASSENGER_API_KEY`              | API key de Wassenger (envío de WhatsApp)                            |
| `WASSENGER_WEBHOOK_SECRET`       | Valida los webhooks entrantes de Wassenger                          |
| `OWNER_WHATSAPP`                 | Teléfono del dueño en formato E.164 (`+5491112345678`) — recibe los avisos |
| `CRON_SECRET`                    | Protege las rutas de cron. String aleatorio, mín. 16 chars          |
| `AUTH_SECRET`                    | Firma la sesión del dashboard. String aleatorio, mín. 16 chars      |
| `DASHBOARD_PASSWORD`             | Contraseña para entrar al dashboard                                 |
| `REDDIT_USER_AGENT`              | User-Agent que Reddit exige en cada request                         |
| `APP_URL`                        | URL base del deploy. En Vercel se deriva sola de `VERCEL_URL` si queda vacía |

Generá los secretos con `openssl rand -hex 32`. **`CRON_SECRET` debe coincidir**
con el secreto `cron_secret` del Vault de Supabase (lo usa `cron.sql`).

### Opcionales (credenciales de fuentes)

| Variable                                          | Habilita                          |
| ------------------------------------------------- | --------------------------------- |
| `FREELANCER_OAUTH_TOKEN`                          | Fuente Freelancer.com (ver abajo) |
| `DISCORD_BOT_TOKEN`                               | Fuente Discord                    |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION` | Fuente Telegram          |
| `SCRAPER_API_KEY`                                 | Fuente Workana (paso 34, opcional)|

Si una de estas falta, su fuente devuelve `[]` sin error y el resto sigue.

#### `FREELANCER_OAUTH_TOKEN` — cómo obtenerlo

La fuente Freelancer.com usa la API oficial (gratis) de proyectos activos, que
exige un token OAuth personal de la cuenta del dueño. Un token de solo lectura
alcanza:

1. Iniciá sesión en [freelancer.com](https://www.freelancer.com) con la cuenta del dueño.
2. Entrá a <https://developers.freelancer.com>.
3. Creá una aplicación y generá un **OAuth access token** personal.
4. Pegá el token en `FREELANCER_OAUTH_TOKEN` en `.env.local`.

El token viaja en el header `freelancer-oauth-v1` de cada request.

#### Telegram — cómo obtener las credenciales

Telegram no expone una API HTTP simple para leer canales públicos arbitrarios:
hay que hablar el protocolo **MTProto** con un cliente autenticado (la librería
GramJS, paquete `telegram`). Eso exige una **sesión de usuario** que se genera
una sola vez, de forma interactiva. Setup manual único:

1. **App de Telegram.** Entrá a <https://my.telegram.org> con la cuenta del
   dueño, abrí **API development tools** y creá una app. Telegram te da un
   **`api_id`** (numérico) y un **`api_hash`**.
2. **Generar la sesión.** Corré una vez el script de login:

   ```bash
   npx tsx scripts/telegram-login.ts
   ```

   El script toma `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` de `.env.local` si ya
   están; si no, te los pide por la terminal. Después pide el **teléfono** (en
   formato internacional, ej. `+5491112345678`) y el **código** que Telegram
   manda a la app (y la contraseña de verificación en dos pasos, si la cuenta la
   tiene).
3. **Guardar el resultado.** Al terminar, el script imprime una línea
   `TELEGRAM_SESSION=...`. Copiá ese valor —junto con `TELEGRAM_API_ID` y
   `TELEGRAM_API_HASH`— a `.env.local` y a Vercel (entorno Production).

El `TELEGRAM_SESSION` es un secreto: da acceso completo a la cuenta de Telegram.
No lo subas al repo.

> El adaptador de Telegram llega en un paso posterior. Hasta entonces —o si las
> tres variables faltan— la fuente queda inerte: devuelve `[]` sin romper nada.

#### Discord — cómo crear el bot y obtener el token

Discord no deja leer canales con una API anónima: hay que registrar un **bot**,
invitarlo a cada servidor y darle permiso de lectura. El adaptador (paso
posterior) usa la **API REST por polling**, no una conexión gateway persistente
—encaja con el modelo de polling del sistema y no necesita un proceso siempre
activo—. Setup manual único:

1. **Crear la aplicación y el bot.** Entrá a
   <https://discord.com/developers/applications> con la cuenta del dueño,
   **New Application**, ponele un nombre. En la pestaña **Bot**, creá el bot.
2. **Copiar el token.** En la pestaña **Bot**, **Reset Token** y copiá el valor
   → variable `DISCORD_BOT_TOKEN` (en `.env.local` y en Vercel, entorno
   Production). El token solo se muestra una vez; si lo perdés, reseteálo de
   nuevo. Es un secreto: no lo subas al repo.
3. **Activar el "Message Content Intent".** En la misma pestaña **Bot**, bajá a
   **Privileged Gateway Intents** y activá **Message Content Intent**. Es un
   intent privilegiado y es **obligatorio**: sin él, la API devuelve el
   contenido de los mensajes vacío y la fuente no detecta nada.
4. **Invitar el bot a cada servidor.** En **OAuth2 → URL Generator**, marcá el
   scope **`bot`** y los permisos **View Channels** y **Read Message History**
   (alcanza con leer; el bot no escribe). Copiá la URL generada, abrila y elegí
   el servidor objetivo. Para aprobar la invitación tenés que ser **admin** de
   ese servidor; si no lo sos, pasale la URL a un admin para que la apruebe.
   Repetí por cada servidor que quieras monitorear.
5. **Copiar los IDs de canal.** En Discord, **Ajustes de usuario → Avanzado →
   Modo desarrollador** (activado). Después, clic derecho sobre cada canal a
   monitorear → **Copiar ID del canal**, y clic derecho sobre el servidor →
   **Copiar ID del servidor**. Esos IDs van en el `config` de la fuente
   `discord` (lo usa el adaptador del paso siguiente).

Con `DISCORD_BOT_TOKEN` seteado, verificá el setup con:

```bash
npx tsx scripts/test-discord.ts
```

El script hace un `GET /users/@me` contra la API de Discord y confirma que el
token es válido y que el bot responde (imprime su nombre e ID). Sin el token, no
falla: avisa que el setup está pendiente.

> El adaptador de Discord llega en un paso posterior. Hasta entonces —o si falta
> `DISCORD_BOT_TOKEN`— la fuente queda inerte: devuelve `[]` sin romper nada.

---

## 5. Las fuentes

Cada fuente que el detector monitorea es un **adaptador** que implementa la
interfaz `SourceAdapter` (`lib/sources/types.ts`). Hay una fila por fuente en la
tabla `sources` con su `enabled`, su `config` (JSON validado contra el
`configSchema` del adaptador) y su `cursor` de polling.

| Slug         | Nombre        | Adaptador | Estado    | Credencial    |
| ------------ | ------------- | --------- | --------- | ------------- |
| `hackernews` | Hacker News   | ✅        | habilitada| —             |
| `reddit`     | Reddit        | ✅        | habilitada| `REDDIT_USER_AGENT` |
| `bluesky`    | Bluesky       | ✅        | habilitada| —             |
| `freelancer` | Freelancer.com| ✅        | habilitada| `FREELANCER_OAUTH_TOKEN` |
| `rss`        | Feeds RSS     | ✅        | habilitada| —             |
| `telegram`   | Telegram      | ❌ pendiente | deshabilitada | `TELEGRAM_*` |
| `discord`    | Discord       | ✅        | habilitada| `DISCORD_BOT_TOKEN` |
| `workana`    | Workana       | ❌ paso 34   | —          | `SCRAPER_API_KEY` |

Hoy hay **5 fuentes activas** con adaptador. `telegram` y `discord` ya tienen su
fila en `sources` pero todavía no su adaptador; `workana` se suma en el paso 34.
La fuente `rss` por sí sola cubre N plataformas (ver [§6](#6-feeds-rss-sin-código)).

### Cómo agregar una fuente nueva

El registry desacopla el polling de las fuentes concretas: sumar una no toca
ningún archivo existente. Cuatro pasos:

1. **Implementar el adaptador.** Creá `lib/sources/<slug>.ts` con un objeto que
   cumpla `SourceAdapter`:
   - `slug` — identificador estable, igual a `sources.slug`.
   - `displayName` — nombre legible (UI, logs).
   - `configSchema` — un schema de Zod que valida el `config` propio de la
     fuente. La ruta de poll valida `sources.config` contra esto antes de
     llamar al adaptador, así `fetchItems` puede asumir que el config es válido.
   - `fetchItems(config, cursor)` — trae los items nuevos desde la última
     corrida y devuelve `{ items, cursor }`. El `cursor` es un JSON opaco que el
     adaptador define a gusto (último ID, timestamp, token de paginación).

2. **Registrarlo.** Al final del archivo, llamá `registerSource(<adapter>)`.

3. **Importarlo.** Agregá `import "@/lib/sources/<slug>";` en
   `lib/sources/index.ts` — el import fuerza el registro como efecto secundario.

4. **Crear la fila en `sources`.** Insertá una fila con el `slug`, el `name`,
   `enabled` y el `config` inicial (que debe satisfacer el `configSchema`):

   ```sql
   insert into sources (slug, name, enabled, config)
   values ('mi-fuente', 'Mi Fuente', true, '{"queries": ["..."]}'::jsonb);
   ```

A partir del próximo poll, `/api/cron/dispatch` la incluye en el fan-out. Tomá
cualquier adaptador existente (`lib/sources/hackernews.ts` es el más simple) como
plantilla.

---

## 6. Feeds RSS sin código

La fuente `rss` no habla con una plataforma concreta: lee **cualquier cantidad de
feeds RSS/Atom** listados en su `config`. Sumar un feed (otra ciudad de
Craigslist, otra bolsa de empleo remoto, cualquier feed) es agregar una entrada
al array `feeds` — **cero código, cero deploy**.

Desde el dashboard: **Configuración → Fuentes → `rss` → editar `config`**. O por
SQL:

```sql
update sources
set config = jsonb_set(
  config, '{feeds}',
  (config->'feeds') || '[{"name": "mi-feed", "url": "https://ejemplo.com/feed.rss"}]'::jsonb
)
where slug = 'rss';
```

Cada feed tiene `name` (legible, viaja en el `author` de cada lead) y `url`. Los
feeds se bajan de a uno, aislados: si uno falla, los demás siguen; solo se marca
la corrida como error si fallan **todos**.

---

## 7. El cron — scheduling autónomo

El sistema corre solo: un cron dispara cada 20 min las tres etapas del pipeline.
Se usa **Supabase Cron** (`pg_cron`), no Vercel Cron — el plan Hobby de Vercel
solo permite frecuencia diaria, inservible para sondear cada 20 min. `pg_cron`
corre dentro de Postgres, soporta frecuencia sub-minuto y dispara HTTP con
`pg_net`. Gratis.

| Job                     | Cron               | Ruta                  |
| ----------------------- | ------------------ | --------------------- |
| `lead-detector-poll`    | `*/20 * * * *`     | `/api/cron/dispatch`  |
| `lead-detector-process` | `5-59/20 * * * *`  | `/api/process`        |
| `lead-detector-notify`  | `12-59/20 * * * *` | `/api/notify`         |
| `lead-detector-health`  | `30 * * * *`       | `/api/health/check`   |

Los offsets (poll en :00, process en :05, notify en :12) le dan a cada etapa
tiempo de adelantarle trabajo a la siguiente.

Los jobs se definen en **`supabase/cron.sql`**, un script **idempotente**
(desagenda por nombre y vuelve a agendar): se puede re-correr sin duplicar jobs.
Cada job hace un `net.http_post` a la ruta `/api/...`, con el header
`x-cron-secret` resuelto en cada corrida desde **Supabase Vault** (secreto
`cron_secret`) — nunca queda en texto plano en `cron.job`.

Las extensiones `pg_cron` y `pg_net` se habilitan en la migración
`0004_cron_extensions`.

> **⚠️ Tras cambiar la URL de la app, re-correr `cron.sql`.** Los jobs apuntan a
> la variable `app_url` definida **dentro** de `cron.sql` (hoy
> `http://localhost:3000`). Al deployar a Vercel —o al cambiar el dominio— hay
> que editar `app_url` por la URL de producción y **re-ejecutar el script
> completo** (con el `execute_sql` del MCP de Supabase, o desde el SQL Editor).
> Si no, los jobs siguen disparando contra la URL vieja y el sistema no procesa
> nada. Es idempotente: re-correrlo no rompe nada.

---

## 8. Costos

| Concepto              | Costo aprox.        | Plan                          |
| --------------------- | ------------------- | ----------------------------- |
| **Claude API**        | **US$10–15 / mes**  | Pago por uso (Haiku + Sonnet) |
| Supabase              | US$0                | Free tier                     |
| Vercel                | US$0                | Hobby                         |
| Wassenger             | según plan WhatsApp | —                             |

El único costo variable real es la API de Claude. El grueso de los leads se
clasifica con **Haiku 4.5** (barato); solo los ambiguos escalan a **Sonnet 4.6**.
El `process` usa *prompt caching* sobre el system prompt estático para no pagar
de nuevo el rol y los ejemplos few-shot en cada lead. El costo de cada lead se
guarda en `leads.llm_cost_usd` y se ve agregado en **Dashboard → Métricas**.

---

## 9. Monitoreo de salud

Un sistema autónomo necesita un "monitoreo del monitor": si deja de funcionar,
nadie lo está mirando. El monitoreo tiene **tres capas**, cada una cubre lo que
la anterior no puede ver:

1. **Self-check interno** — `lead-detector-health` (cron, cada hora) dispara
   `POST /api/health/check`, que evalúa fallas *parciales*: no hubo polls
   recientes, una fuente acumula polls fallidos, la cola de IA se estancó, las
   notificaciones fallan, o el propio `pg_cron` tuvo corridas fallidas (lo lee
   de `cron.job_run_details` vía el RPC `health_cron_failures`). Si algo está
   roto, manda un WhatsApp al dueño. Tiene **anti-spam**: guarda en `settings`
   (`health_last_alert`) la firma del problema y solo re-avisa si la firma
   cambia o pasa un cooldown de 6 h; al recuperarse avisa una vez y limpia la
   firma.
2. **Lectura del cron** — la capa 1 también cubre que el cron de Postgres falle,
   algo que el cron mismo no puede reportar porque no llega a la app.
3. **Monitor externo de uptime** — cubre la **caída total**: si Vercel está
   abajo, las capas 1 y 2 tampoco corren. Hay que dar de alta un monitor de
   uptime gratuito ([UptimeRobot](https://uptimerobot.com),
   [Better Stack](https://betterstack.com) o [Cron-job.org](https://cron-job.org))
   que haga un ping HTTP a **`${APP_URL}/api/health`** cada ~5 min. Ese endpoint
   es público (sin secreto solo devuelve `{ status }`) y responde **503** cuando
   el sistema está caído, así que el monitor alerta por mail/Telegram solo.

---

## 10. Configuración desde el dashboard

El dashboard de producción (`${APP_URL}`, login con `DASHBOARD_PASSWORD`) tiene
tres vistas:

- **Leads** (`/leads`) — los leads detectados, con su categoría, score y mensaje
  sugerido. Cada lead permite dar **feedback** (`responded` / `interested` /
  `not_relevant`), que alimenta los ejemplos few-shot del clasificador.
- **Métricas** (`/metrics`) — el embudo (detectados → pre-filtro → clasificados →
  hiring → respondidos) y el costo de IA acumulado.
- **Configuración** (`/config`) — todo lo manejado por datos, **editable sin
  tocar código ni redeployar**; los cambios impactan en el próximo poll.

En **Configuración** se ajustan:

- **Keywords del pre-filtro** — términos `include` (un item avanza a la IA solo
  si contiene al menos uno) y `exclude` (si contiene alguno, se descarta antes de
  la IA), por idioma. El pre-filtro es determinístico y gratis: descarta el ruido
  antes de gastar en Claude.
- **Fuentes** — el `enabled` y el `config` de cada fuente. El `config` se valida
  contra el `configSchema` del adaptador antes de guardar.
- **Ajustes generales** (`settings`):
  - `notify_rule` — qué categorías y qué `minScore` ameritan un WhatsApp
    (default: `{ categories: ["hiring"], minScore: 70 }`).
  - `max_notifications_per_run` — tope de avisos por corrida de `notify`
    (default: 10).
  - `freelancer_profile` — el perfil del freelancer que el clasificador usa para
    decidir si un lead encaja.

---

## 11. Scripts

| Comando             | Qué hace                                                       |
| ------------------- | -------------------------------------------------------------- |
| `npm run dev`       | Entorno de desarrollo                                          |
| `npm run build`     | Build de producción                                            |
| `npm test`          | Suite de tests (Vitest) — no pega a APIs externas              |
| `npm run typecheck` | Chequeo de tipos (`tsc --noEmit`)                              |
| `npm run lint`      | ESLint                                                         |
| `npm run verify`    | Lint → typecheck → tests → build, en orden (la misma secuencia del CI) |
| `npm run eval`      | Evaluación del clasificador (ver §12) — **hace llamadas reales a Claude** |
| `npx tsx scripts/telegram-login.ts` | Genera el `TELEGRAM_SESSION` — setup manual único de Telegram (ver §4) |
| `npx tsx scripts/test-discord.ts` | Verifica el bot de Discord (`GET /users/@me`) — setup manual único de Discord (ver §4) |
| `npx tsx scripts/test-discord-adapter.ts` | Corre el adaptador de Discord con el config real e imprime items y cursor |

> **Gotcha de build local:** `next build` falla si `NODE_ENV=development` está
> forzado en el entorno (error de prerender en `/_global-error`,
> `useContext` null). Corré el build con `NODE_ENV=production npm run build`. El
> CI no tiene este problema porque no fuerza `NODE_ENV`.

### Integración continua

Si el repo está en GitHub, `.github/workflows/ci.yml` corre `lint → typecheck →
tests → build` en cada `push` y cada `pull_request`. No corre `npm run eval` (pega
a Claude, cuesta dinero); los tests unitarios no usan secretos.

---

## 12. Evaluación del clasificador

`npm run eval` pasa cada caso etiquetado de `test/fixtures/classifier-cases.ts`
por `classifyLead` y reporta la precisión global, una matriz de confusión y el
detalle de los casos fallados. Termina con código de salida **1** si la precisión
cae por debajo del **85 %**, así sirve como verificación de regresión.

Es una herramienta **manual**: se corre al tocar el system prompt o los few-shot
del clasificador. No está en `npm test` ni en el CI porque hace **llamadas reales
a Claude** (cuestan y requieren una `ANTHROPIC_API_KEY` válida en `.env.local`).

El script se re-ejecuta a sí mismo con `--conditions=react-server` y
`--env-file=.env.local` para resolver `server-only` y cargar el entorno; no hace
falta pasarle flags.

---

## 13. Verificación end-to-end

Para verificar el pipeline a mano, disparar las rutas con el header
`x-cron-secret`. Reemplazá `$APP_URL` y `$CRON_SECRET` por los valores reales.

```bash
# 1. Polling — debería aparecer leads nuevos de varias fuentes
curl -X POST "$APP_URL/api/cron/dispatch" -H "x-cron-secret: $CRON_SECRET"

# 2. Clasificación — los leads `pending` quedan `done`, con categoría y costo
curl -X POST "$APP_URL/api/process" -H "x-cron-secret: $CRON_SECRET"

# 3. Notificación — llega un WhatsApp real al dueño por cada lead que califica
curl -X POST "$APP_URL/api/notify" -H "x-cron-secret: $CRON_SECRET"

# 4. Estado del sistema — debería devolver {"status":"ok"}
curl "$APP_URL/api/health"

# (detalle completo, con el secreto:)
curl "$APP_URL/api/health" -H "x-cron-secret: $CRON_SECRET"
```

`dispatch` responde de inmediato y hace el fan-out en `after()`: esperá unos
segundos y revisá la tabla `runs` (debe haber un `run` de `poll` por fuente) y
`leads`. Después abrí el dashboard, logueate y revisá leads, el embudo de
métricas y la configuración.

**Verificación de autonomía:** sin tocar nada, esperá al próximo tick del cron
(`*/20`, como mucho ~20 min) y confirmá que aparece un `run` nuevo de `poll` con
`status='ok'` en la tabla `runs`. Eso prueba que el sistema corre solo.

---

## 14. Troubleshooting

**Primer lugar a mirar: la tabla `runs`.** Es la traza operativa. Cada corrida
deja una fila con `kind`, `status` (`running`/`ok`/`error`), `error` y los
contadores. Una corrida `error`, o la ausencia de corridas recientes, dice dónde
empezar.

```sql
select id, kind, source, status, started_at, finished_at, error
from runs order by started_at desc limit 20;
```

| Síntoma                                  | Dónde mirar / qué hacer                                              |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `/api/health` devuelve `down` (503)       | No hubo un poll exitoso en la última hora. Revisá `runs` y el cron.  |
| No aparecen `runs` nuevos                 | El cron no llega a la app. Verificá `app_url` en `cron.sql` y **re-corré el script**. Revisá `cron.job_run_details`. |
| Una fuente acumula polls `error`          | Mirá el `error` de esa fuente en `runs`; suele ser credencial faltante o config inválido. |
| Leads se quedan en `pending`              | `process` no drena. Revisá `runs` de `kind='process'`; típico: `ANTHROPIC_API_KEY` inválida o sin crédito. |
| WhatsApps no llegan                       | Revisá `notifications` (`status='failed'` + `error`) y `WASSENGER_API_KEY` / `OWNER_WHATSAPP`. |
| Las rutas API devuelven 401               | El `x-cron-secret` no coincide. `CRON_SECRET` (env de Vercel) debe ser igual al secreto `cron_secret` del Vault. |
| La app no arranca                         | `lib/env.ts` rechazó el entorno: el error nombra la variable faltante o inválida. |

Para rastrear una corrida puntual, los logs traen el `runId` en cada línea:
buscá por ese `runId` en los logs de Vercel (Runtime Logs) para ver toda la
corrida.

---

## 15. Estado del deploy

> **⚠️ Verificación end-to-end de producción: pendiente.** Al cierre del paso 29,
> el deploy del paso 28 quedó **incompleto** y la verificación end-to-end contra
> producción **no se pudo ejecutar**. Concretamente:
>
> - **No hay proyecto `detector-leads` en Vercel** — la app no está deployada y
>   no existe una `APP_URL` de producción.
> - **Faltan secretos reales** — `.env.vercel` tiene placeholders
>   (`REEMPLAZAR_*`) para `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`,
>   `WASSENGER_API_KEY`, `OWNER_WHATSAPP` y `APP_URL`. Son credenciales reales
>   que debe cargar el dueño.
> - **El cron apunta a `localhost`** — los 4 jobs de `pg_cron` en Supabase están
>   `active` pero su `app_url` sigue siendo `http://localhost:3000`; por eso
>   `runs` está vacía (0 corridas) pese a que el cron dispara cada 20 min.
>
> **Para completar la puesta en producción:**
>
> 1. Crear el proyecto en Vercel y deployar el repo.
> 2. Cargar en Vercel (entorno Production) las variables de `.env.vercel`,
>    reemplazando los `REEMPLAZAR_*` por los valores reales y `APP_URL` por la
>    URL de producción definitiva.
> 3. Editar `app_url` en `supabase/cron.sql` con esa URL y **re-correr el
>    script** (ver [§7](#7-el-cron--scheduling-autónomo)).
> 4. Recién entonces correr la verificación end-to-end de [§13](#13-verificación-end-to-end).
>
> El **código está verificado**: `npm run lint` (0 errores), `npm run typecheck`,
> `npm test` (46 tests) y `npm run build` (con `NODE_ENV=production`) pasan. Lo
> que falta es infraestructura y secretos, no código.

# Autopilot v2 — Runbook de activación

> Este documento cubre los pasos para encender la capa de outreach automático
> (v2) en producción. Asumís que el sistema v1 (Lead Detector) ya está deployado
> y funcionando. Si no, completá primero los pasos del §15 del README.

---

## Checklist de activación (orden obligatorio)

### 1. Aplicar la migración `0009_conversations`

La v2 necesita las tablas `conversations` y `messages`, nuevas columnas en
`leads` y los RPCs de claims resilientes.

**Opción A — MCP de Supabase (recomendado):**
```
apply_migration  →  supabase/migrations/0009_conversations.sql
```

**Opción B — SQL Editor de Supabase:**
Copiá el contenido de `supabase/migrations/0009_conversations.sql` y ejecutalo
en el SQL Editor del proyecto.

La migración es idempotente: se puede re-correr sin romper nada.

> Opcional: regenerar los tipos TypeScript con el MCP de Supabase
> (`generate_typescript_types`) y reemplazar `types/database.ts`.

---

### 2. Generar y setear `WEBHOOK_SECRET`

Los webhooks entrantes (`/api/inbound/*`) se validan con este secreto.

```bash
openssl rand -hex 32
```

Cargá el valor resultante como variable de entorno en Vercel (Production):
`WEBHOOK_SECRET=<valor>`

> `CRON_SECRET` ya debe estar en Vercel y coincidir con el secreto `cron_secret`
> del Vault de Supabase. Si no está, generalo y cargalo también:
> `openssl rand -hex 32` → Vercel env + Vault de Supabase (nombre: `cron_secret`).

---

### 3. Canal WhatsApp — configurar el webhook de Evolution API

Evolution API necesita saber adónde mandar los mensajes entrantes.

En el panel de Evolution API, configurá el webhook de tu instancia. El endpoint
acepta el secreto por **header** o por **query param** — usá el que tu versión de
Evolution soporte:

- **Con header** (preferido): URL `${APP_URL}/api/inbound/whatsapp` + header
  `x-webhook-secret: <WEBHOOK_SECRET>`.
- **Sin headers custom** (fallback): poné el secreto en la URL del webhook:
  ```
  ${APP_URL}/api/inbound/whatsapp?s=<WEBHOOK_SECRET>
  ```
  Viaja sobre HTTPS y se compara timing-safe igual que el header.

Activá en Evolution el evento `messages.upsert` (mensajes nuevos). El endpoint
ignora los envíos propios (`fromMe`) y los eventos que no son texto.

---

### 4. Canal Telegram — worker en Railway

Telegram requiere un proceso persistente (MTProto no funciona en serverless).

**4a. Generar la sesión de Telegram (una sola vez):**
```bash
npx tsx scripts/telegram-login.ts
```
El script te pide `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, el teléfono y el
código que Telegram manda a la app. Al terminar imprime `TELEGRAM_SESSION=...`.

**4b. Desplegar el worker a Railway:**
- Creá un nuevo servicio en Railway apuntando a la carpeta `worker/` del repo.
- Seteá las variables de entorno del worker:
  - `TELEGRAM_API_ID`
  - `TELEGRAM_API_HASH`
  - `TELEGRAM_SESSION`
  - `APP_URL` (la URL de producción de Vercel, para reenviar entrantes)
  - `WEBHOOK_SECRET` (el mismo que en Vercel)

**4c. Conectar el worker con Vercel:**
- Copiá la URL pública del worker de Railway (ej. `https://radar-worker.railway.app`).
- Cargala en Vercel: `TELEGRAM_WORKER_URL=<url>`

---

### 5. Canal Bluesky

**5a.** Generá un app password en <https://bsky.app> →
Ajustes → App passwords → **Agregar app password**.
Usá un nombre descriptivo (ej. `radar-autopilot`). Esto **no** es la
contraseña real de la cuenta.

**5b.** Cargá en Vercel (Production):
```
BLUESKY_IDENTIFIER=<handle o e-mail de la cuenta>
BLUESKY_APP_PASSWORD=<app password del paso anterior>
```

---

### 6. Canal Reddit (opcional — gated)

Reddit tiene autopilot desactivado por defecto (`channel_autopilot.reddit = false`).
No es necesario para arrancar; completalo cuando quieras activar el canal.

**6a.** Creá una "script app" en <https://www.reddit.com/prefs/apps>.

**6b.** Obtené un refresh token OAuth (flujo `refresh_token` con scope
`identity read privatemessages submit`).

**6c.** Cargá en Vercel:
```
REDDIT_CLIENT_ID=<client id>
REDDIT_CLIENT_SECRET=<client secret>
REDDIT_REFRESH_TOKEN=<refresh token>
```

> El canal queda gated: incluso con las credenciales cargadas, `autopilot` para
> Reddit permanece en `false` hasta que lo prendas explícitamente desde
> `/config → Autopilot → por canal`.

---

### 7. Re-correr `supabase/cron.sql` con la URL de producción

Los nuevos jobs de v2 (engage, followup, inbound) necesitan apuntar a la URL
real de la app.

1. Abrí `supabase/cron.sql` y cambiá:
   ```sql
   app_url text := 'http://localhost:3000';
   ```
   por la URL de producción de Vercel, ej.:
   ```sql
   app_url text := 'https://radar.vercel.app';
   ```

2. Ejecutá el script completo en Supabase (MCP `execute_sql` o SQL Editor).
   Es idempotente: re-corre sin duplicar los jobs existentes y agrega los tres
   nuevos (`engage`, `followup`, `inbound`).

**Resultado esperado:** 7 jobs activos en `cron.job`:

| Job                      | Schedule         | Ruta                   |
|--------------------------|------------------|------------------------|
| `lead-detector-poll`     | `*/20 * * * *`   | `/api/cron/dispatch`   |
| `lead-detector-process`  | `5-59/20 * * * *`| `/api/process`         |
| `lead-detector-notify`   | `12-59/20 * * * *`| `/api/notify`         |
| `lead-detector-health`   | `30 * * * *`     | `/api/health/check`    |
| `lead-detector-engage`   | `8-59/20 * * * *`| `/api/engage`          |
| `lead-detector-followup` | `15 * * * *`     | `/api/followup`        |
| `lead-detector-inbound`  | `*/5 * * * *`    | `/api/inbound/poll`    |

---

### 8. Cargar el Playbook y la config de Autopilot

Abrí el dashboard de producción (`${APP_URL}`) → **Configuración → Playbook**:

- **Persona:** quién sos y cómo hablás.
- **Oferta:** qué hacés (servicios, stack, diferencial).
- **Precios:** rangos. El agente nunca sale de este rango.
- **Tono:** estilo de los mensajes.
- **Handoff triggers:** cuándo pasarle el lead al dueño.

En **Configuración → Autopilot**, revisá:
- `engage_rule` (categorías y score mínimo para contactar).
- `channel_autopilot` (qué canales están activos).
- `outreach_daily_cap` (tope diario de primeros contactos, default 20).
- `followup_policy` (esperas entre reengaches, default 24h y 72h, máx. 2).

---

### 9. Encender el switch maestro

Cuando todo lo anterior esté listo y verificado:

**Configuración → Autopilot → `outreach_enabled` → ON**

Hasta ese momento el sistema corre en **modo shadow**: detecta, clasifica y
prepara conversaciones, pero no contacta a nadie. Es seguro tener todos los
pasos anteriores configurados con `outreach_enabled = false`.

---

## Verificación rápida post-activación

```bash
# Los jobs están registrados en Supabase
select jobname, schedule, active from cron.job order by jobname;

# No hay conversaciones fallidas recientes
select status, count(*) from conversations
where created_at > now() - interval '1 hour'
group by status;

# El health check pasa
curl "$APP_URL/api/health" -H "x-cron-secret: $CRON_SECRET"
```

---

## Costos estimados (v2)

| Concepto                      | Estimado          | Notas                                      |
|-------------------------------|-------------------|--------------------------------------------|
| **Railway** (worker Telegram) | ~US$5/mes         | ~0.5–1 GB RAM, proceso siempre prendido    |
| **Anthropic** (agente)        | ~US$2–10/mes      | Haiku + caching; depende del volumen       |
| Vercel                        | US$0              | Hobby                                      |
| Supabase                      | US$0              | Free tier (pg_cron incluido)               |
| Telegram / Bluesky / Reddit   | US$0              | APIs gratuitas                             |
| **Total v2**                  | **~US$5–15/mes**  | Muy similar al costo v1 (solo Claude)      |

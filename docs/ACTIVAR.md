# Activar el radar — camino mínimo (sólo Bluesky)

> El código está 100% terminado y verificado. Esto es lo único que falta: prenderlo.
> Este es el camino **más barato y simple** para que quede **100% automático**:
> sólo Bluesky. No necesita worker de Railway, ni WhatsApp/Evolution, ni teléfonos.
> Telegram y WhatsApp se pueden sumar después (ver [`DEPLOY.md`](./DEPLOY.md)).

Qué va a hacer cuando lo prendas: cada 20 min busca en Bluesky gente que pide una
página web, filtra con IA, le manda un primer mensaje, conversa solo, hace
seguimiento si no responden, y te avisa por WhatsApp cuando un lead está caliente
para que vos cierres.

---

## Lo que necesito de vos (5 cosas)

1. **Cuenta de Supabase del radar** — ¿creo una nueva yo, o usás una tuya? (Decímelo
   y aplico todas las migraciones por MCP, o te paso el SQL para pegar.)
2. **Anthropic API key** (`sk-ant-...`) — es el cerebro que clasifica y conversa.
3. **Cuenta de Bluesky** (handle/email) **+ app password** — la cuenta desde la que
   el radar manda los mensajes. El app password se crea en
   bsky.app → Ajustes → App passwords (NO es tu contraseña real).
4. **Tu WhatsApp** en formato `+549...` — adónde te llegan los avisos de leads
   calientes. (Para *recibir* avisos hace falta una instancia de Evolution API;
   si no la tenés a mano, podemos arrancar sin WhatsApp y ver los leads en el panel.)
5. **OK para deployar** en Vercel bajo tu team "Manuel's projects".

Los 3 secretos de seguridad (CRON_SECRET, AUTH_SECRET, WEBHOOK_SECRET) ya te los
generé — están en el chat de la sesión. No hace falta que los inventes.

---

## Pasos (en orden)

### 1. Base de datos (Supabase)
Crear el proyecto y aplicar **todas** las migraciones en orden:
`supabase/migrations/0001_…` → `0010_web_targeting.sql`, más `supabase/cron.sql`.
Son idempotentes. (Puedo hacerlo yo por MCP si me das el OK y el proyecto.)

### 2. Deploy en Vercel
Importar el repo, y cargar las **env vars** (Production). Mínimo para Bluesky:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
CRON_SECRET=<el que te pasé>
AUTH_SECRET=<el que te pasé>
WEBHOOK_SECRET=<el que te pasé>
DASHBOARD_PASSWORD=<una contraseña para entrar al panel>
BLUESKY_IDENTIFIER=<tu handle o email>
BLUESKY_APP_PASSWORD=<el app password>
REDDIT_USER_AGENT=radar/1.0
APP_URL=https://<tu-deploy>.vercel.app
OWNER_WHATSAPP=+549...        # tu número (para avisos)
# Evolution (WhatsApp) — opcional para arrancar; necesario para que lleguen avisos:
EVOLUTION_API_URL=...  EVOLUTION_API_KEY=...  EVOLUTION_INSTANCE=...
```

### 3. Cron
Editar `supabase/cron.sql` (la línea `app_url`) con la URL real de Vercel y correrlo.
Deja 7 jobs activos (poll, process, notify, engage, followup, inbound, health).

### 4. Encender
En el panel `https://<tu-deploy>.vercel.app` → **Configuración → Autopilot**:
- (Opcional) Revisá el **Playbook**: oferta, **precios**, tono. Hay un default razonable
  ya cargado; ajustá los precios a los tuyos.
- Poné **`outreach_enabled` → ON**.

Listo. A partir de ahí trabaja solo.

---

## Para sumar más alcance después
- **WhatsApp** (recibir/responder): configurar Evolution API + webhook (ver `DEPLOY.md` §3).
- **Telegram** (DM en grupos): worker en Railway (ver `DEPLOY.md` §4).
- **Reddit**: viene apagado por riesgo de baneo; activable en `DEPLOY.md` §6.

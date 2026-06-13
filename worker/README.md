# radar-telegram-worker

Always-on Node.js service (Railway) that holds a Telegram MTProto session via
GramJS and bridges it to the main Radar app (Vercel) over HTTP.

Serverless functions can't maintain a persistent MTProto connection, so this
worker does it instead. It:

- **Sends DMs** when the app calls `POST /send`
- **Relays incoming DMs** to the app via `POST /api/inbound/telegram`

---

## HTTP contract

### App → Worker

```
POST /send
x-webhook-secret: <WEBHOOK_SECRET>

{ "userId": "123456", "accessHash": "9876543210" | null, "text": "Hello" }

→ 200  { "id": "987" }          message sent, id is the Telegram message id
→ 401  { "error": "..." }       wrong or missing secret
→ 500  { "error": "..." }       send failed
```

### Worker → App (on each incoming private DM)

```
POST <APP_URL>/api/inbound/telegram
x-webhook-secret: <WEBHOOK_SECRET>

{
  "userId":      "123456",
  "accessHash":  "9876543210" | null,
  "username":    "johndoe"    | null,
  "firstName":   "John"       | null,
  "text":        "Hi there",
  "messageId":   "42"
}
```

### Health check

```
GET /health  →  200  { "ok": true, "connected": true }
```

---

## Obtaining a session string (TELEGRAM_SESSION)

The main app contains an interactive login script at `scripts/telegram-login.ts`.

Steps:

1. Go to <https://my.telegram.org> → "API development tools" → create an app.
   You'll get a numeric `api_id` and a hex `api_hash`.

2. From the **root** of the main Next.js project (not this folder), run:

   ```bash
   npx tsx scripts/telegram-login.ts
   ```

   The script auto-loads `.env.local` if present. If `TELEGRAM_API_ID` and
   `TELEGRAM_API_HASH` are already there it won't prompt for them.

3. Enter your phone number in international format (`+5491112345678`), then
   the code Telegram sends to your app, and your 2FA password if set.

4. The script prints a `TELEGRAM_SESSION=...` line. Copy the value.

The session string gives **full account access** — treat it like a password.
Never commit it to the repository.

---

## Local development

```bash
cd worker
cp .env.example .env
# Fill in the values in .env
npm install
npm run dev
```

The server starts on `PORT` (default 8080). Test with:

```bash
curl http://localhost:8080/health
```

---

## Deploy to Railway

1. **Create a new Railway service** pointing to this repository.
   - In "Settings → Source", set the **Root Directory** to `worker`.
   - Railway will detect `package.json` and use Nixpacks to build it.

2. **Set environment variables** in Railway → Variables:

   | Variable           | Value                                        |
   |--------------------|----------------------------------------------|
   | `TELEGRAM_API_ID`  | Numeric api_id from my.telegram.org          |
   | `TELEGRAM_API_HASH`| Hex api_hash from my.telegram.org            |
   | `TELEGRAM_SESSION` | String printed by `telegram-login.ts`        |
   | `APP_URL`          | Your Vercel deployment URL (no trailing `/`) |
   | `WEBHOOK_SECRET`   | Long random string (same as in Vercel)       |
   | `PORT`             | Leave unset — Railway injects it             |

3. **Deploy.** Railway will run `npm start` (→ `node --import tsx/esm src/index.ts`).
   The service stays alive; GramJS auto-reconnects on network hiccups.

4. **Note the Railway public URL** for the next step.

---

## Connecting the main app

In your Vercel project's environment variables (all environments or at least
Production), set:

| Variable               | Value                                 |
|------------------------|---------------------------------------|
| `TELEGRAM_WORKER_URL`  | Railway public URL of this service    |
| `WEBHOOK_SECRET`       | Same secret as the worker             |

The main app's `POST /send` handler should call:

```
POST <TELEGRAM_WORKER_URL>/send
x-webhook-secret: <WEBHOOK_SECRET>
{ "userId": "...", "accessHash": "...", "text": "..." }
```

And the inbound route `app/api/inbound/telegram/route.ts` receives relayed DMs
from the worker.

---

## Architecture summary

```
Vercel (main app)
  │
  │  POST /send (outbound DM request)
  ▼
Railway (this worker)  ←─── holds persistent MTProto session
  │
  │  POST /api/inbound/telegram (relay incoming DMs)
  ▼
Vercel (main app)
```

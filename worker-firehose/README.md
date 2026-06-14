# radar-firehose-worker

Always-on Node.js service (Railway) that consumes the **Bluesky firehose
(Jetstream)** and detects leads in real time. It is the "brain" of Bluesky
detection: it runs the cheap deterministic layers over the *entire* network
stream and writes `leads` straight into Supabase. Everything downstream
(`/api/process` → notify → engage → conversation) is unchanged.

See `docs/FIREHOSE.md` in the repo root for the full design and rationale. This
README is the operational reference for the worker itself.

```
Jetstream (wss, all posts) ──► worker-firehose (Railway, persistent)
                                  │  Layer 1: language (franc)   — discard 'en'
                                  │  Layer 2: keywords (table)   — intent net
                                  │  → resolve handle → INSERT leads (pending)
                                  ▼
                    Supabase `leads`  ──►  /api/process (Vercel, PAID, budgeted)
```

It shares the **pure** filter modules with the app (`lib/filter/normalize.ts`
and `lib/filter/match.ts`) so there is zero divergence between what the worker
filters and what the rest of the system considers a "lead". It does **not** send
WhatsApp — the budget-cap notice is sent by `/api/process`.

---

## What it does (per event)

1. **Connect** to the Jetstream over WebSocket, subscribing only to
   `app.bsky.feed.post`.
2. For each `commit` / `operation:"create"` on that collection:
   - **Layer 1 (language):** `detectLang(title + body)`. Discard `'en'`; keep
     `'es'` **and `'other'`** (short posts franc can't classify — recall).
   - **Layer 2 (keywords):** `prefilter({title:'', body:text}, lang, keywords)`
     against the keywords loaded from the `keywords` table (enabled only).
3. **Survivors** (few per day): resolve the author's **handle** from their DID
   (`com.atproto.repo.describeRepo`, cached) to build the **same** public URL the
   search-poll builds → **same `content_hash`** → perfect dedup. Then `upsert`
   into `leads` with `ignoreDuplicates` (both unique indexes covered).
4. **Budget:** the `classifier_paused` flag (table `settings`) is cached and
   refreshed every ~60 s. While `true`, the worker **stops inserting** (it counts
   and logs the skipped posts) so the queue doesn't inflate.
5. **Robustness:** the `cursor` (`time_us`) is persisted to
   `settings['firehose_cursor']` (throttled, ~5 s) and used to resume after a
   crash/redeploy. Reconnect uses exponential backoff + jitter. Keywords are
   reloaded every ~5 min (editable without a redeploy).

### Dedup invariant (important)

The worker reconstructs the exact same `RawItem` the search-poll's `toRawItem`
builds — same `title` (first non-empty line, truncated to 120 chars, or
`"Bluesky post"`), same `body` (trimmed text), same `url`
(`https://bsky.app/profile/{handle}/post/{rkey}`) — and computes
`content_hash = sha256(normalize(title + " " + body + " " + url))` with the same
`contentHash` function. This is asserted by a test
(`content_hash coincide con el del search-poll`). If the hash diverged, the same
post would be inserted twice while both detectors run in parallel.

> **Spec note / decision:** `docs/FIREHOSE.md` lists `title=''` for the inserted
> row. That would **break dedup** with the search-poll, which persists
> `content_hash = contentHash(toRawItem(post))` with a non-empty `title` (see
> `app/api/poll/[source]/route.ts` line ~112 and `lib/sources/bluesky.ts`
> `toRawItem`). The worker therefore stores the **same non-empty `title`** as the
> search-poll (so the hash matches) but, per the spec, runs the **keyword match**
> with `{title:'', body:text}`. Both behaviors coexist without conflict.

---

## Jetstream API — what was confirmed

Verified against the official `bluesky-social/jetstream` README and the atproto
lexicons (training data was treated as stale per `AGENTS.md`):

- **Endpoint:** `wss://<host>/subscribe`. Public hosts:
  `jetstream1.us-east`, `jetstream2.us-east`, `jetstream1.us-west`,
  `jetstream2.us-west` (all `.bsky.network`). Default here:
  `wss://jetstream2.us-east.bsky.network/subscribe`.
- **Query params:** `wantedCollections` (NSID filter, max 100; we send
  `app.bsky.feed.post`), `wantedDids` (max 10k), `cursor` (unix **microseconds**,
  for replay), `compress` (zstd), `maxMessageSizeBytes`, `requireHello`.
- **Event shape** (a `commit` create):
  ```json
  {
    "did": "did:plc:...",
    "time_us": 1725911162329308,
    "kind": "commit",
    "commit": {
      "rev": "3l3qo2vutsw2b",
      "operation": "create",
      "collection": "app.bsky.feed.post",
      "rkey": "3l3qo2vuowo2b",
      "record": { "$type": "app.bsky.feed.post", "text": "...", "createdAt": "..." },
      "cid": "bafy..."
    }
  }
  ```
- **Post record:** `text` (string) and `createdAt` (datetime string) are the two
  required fields of `app.bsky.feed.post`. We use `createdAt` for `posted_at`
  (fallback `null`).
- **Cursor / resume:** reconnect with the `time_us` of the last processed event;
  the docs recommend a small negative buffer for gapless replay — we subtract 5 s
  (`5_000_000` µs). Any resulting double-delivery is absorbed by the dedup hash.
- **DID → handle:** `com.atproto.repo.describeRepo` is a `query` (GET) taking
  `repo` (handle or DID); its output includes `handle` and `did`. Called
  **unauthenticated** against `https://api.bsky.app` — the same host the
  search-poll already uses successfully (`public.api.bsky.app` is CDN-blocked for
  some endpoints; see `lib/sources/bluesky.ts`).

---

## Build & run

This worker is a **separate package** with its own `node_modules`. It imports the
app's pure filter modules by relative path (`@/lib/filter/*` → `../lib/filter/*`
via the `paths` mapping in `tsconfig.json`). Those modules use only `import type`
aliases that esbuild erases.

Because the shared app modules live under the repo root (which is **not**
`"type":"module"`), running them directly through `tsx` hits Node's CJS
extensionless-import resolution and fails. The worker therefore **bundles with
esbuild** for both production and tests (esbuild inlines and resolves the shared
modules correctly). This is the standard Railway "build then run dist" pattern.

```bash
cd worker-firehose
npm install            # installs ONLY here (ws, @supabase/supabase-js, franc-min, …)
npm run typecheck      # tsc --noEmit  (uses moduleResolution: bundler + @/* paths)
npm run build          # esbuild → dist/index.mjs (self-contained bundle)
npm test               # esbuild-bundles the *.test.ts then runs node --test
npm start              # prestart builds, then runs node dist/index.mjs
npm run dev            # esbuild --watch + node --watch (local iteration)
```

| Script      | What it does                                                        |
|-------------|---------------------------------------------------------------------|
| `build`     | Bundle `src/index.ts` → `dist/index.mjs` (`--packages=external`)     |
| `start`     | `prestart` runs `build`, then `node dist/index.mjs`                  |
| `dev`       | esbuild watch + `node --watch` on the bundle                        |
| `typecheck` | `tsc --noEmit`                                                      |
| `test`      | bundle test files → `node --test dist/test/*.mjs`                   |

---

## Environment

| Variable                     | Required | Description                                                    |
|------------------------------|----------|----------------------------------------------------------------|
| `SUPABASE_URL`               | yes      | Project URL, no trailing slash.                                |
| `SUPABASE_SERVICE_ROLE_KEY`  | yes      | Service-role key (bypasses RLS). **Secret.**                   |
| `JETSTREAM_URL`              | no       | Override the Jetstream instance. Defaults to jetstream2.us-east; the worker appends `?wantedCollections=app.bsky.feed.post` if no query string is present. |
| `ATPROTO_API_URL`            | no       | Host for DID→handle resolution. Defaults to `https://api.bsky.app`. |
| `PORT`                       | no       | Health server port. Railway injects it; defaults to 8080.      |

See `.env.example`. The worker reads `process.env` directly (it is **not** part
of the Next.js app, so it does not use `lib/env.ts`).

### Health check

```
GET /health → 200 { ok, connected, paused, keywords, cursor, stats }
```

---

## Deploy to Railway

1. **Create a new Railway service** pointing to this repository.
   - In *Settings → Source*, set the **Root Directory** to `worker-firehose`.
   - Nixpacks detects `package.json`. The `Procfile` runs
     `npm run build && node dist/index.mjs`.
2. **Set environment variables** (Railway → Variables):

   | Variable                    | Value                                   |
   |-----------------------------|-----------------------------------------|
   | `SUPABASE_URL`              | The radar project URL                   |
   | `SUPABASE_SERVICE_ROLE_KEY` | The service-role key                    |
   | `JETSTREAM_URL`             | *(optional)* pin a different instance   |
   | `ATPROTO_API_URL`           | *(optional)* defaults to api.bsky.app   |
   | `PORT`                      | Leave unset — Railway injects it        |

3. **Deploy.** The service stays alive; it reconnects to the Jetstream with
   backoff and resumes from the persisted cursor on restart.
4. **Verify live:** watch the logs for `Jetstream conectado` and the periodic
   `stats` line; check `leads` of `source='bluesky'` with `llm_status='pending'`
   are arriving. Confirm `$` consumed in `/config`.
5. **Turn off the search-poll** (only once the worker is verified, to avoid a
   detection gap): `update sources set enabled=false where slug='bluesky';`

---

## Architecture summary

```
                    Supabase (radar)
                    ├─ keywords   (Layer 2 vocabulary, reloaded ~5 min)
                    ├─ settings   (classifier_paused ~60 s; firehose_cursor)
                    └─ leads      (upsert, ignoreDuplicates)
                         ▲
                         │ service-role client (own supabase-js)
Bluesky Jetstream ──ws──►│ worker-firehose (Railway)
  app.bsky.feed.post     │   gate (lang+keywords, pure) → resolve handle → insert
                         │
api.bsky.app  ◄──http────┘   describeRepo (DID → handle, cached, unauth)
```

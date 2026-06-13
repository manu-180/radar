/**
 * Radar — Telegram MTProto Worker
 *
 * Bridges Telegram MTProto (which can't run on serverless Vercel) to the main
 * Radar app over HTTP with a shared secret.
 *
 * Directions:
 *   App   → Worker  POST /send                    — send a DM to a Telegram user
 *   Worker → App    POST /api/inbound/telegram     — relay incoming private DMs
 *
 * Also:
 *   GET /health   — liveness / connection check
 */

import http from "node:http";
import bigInt from "big-integer";
import { Api, Logger, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, NewMessageEvent } from "telegram/events/index.js";

// ─── Environment ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      JSON.stringify({ level: "fatal", msg: `Missing required env var: ${name}`, ts: new Date().toISOString() }),
    );
    process.exit(1);
  }
  return value;
}

const API_ID: number = (() => {
  const raw = requireEnv("TELEGRAM_API_ID");
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(
      JSON.stringify({ level: "fatal", msg: `TELEGRAM_API_ID must be a positive integer, got: "${raw}"` }),
    );
    process.exit(1);
  }
  return n;
})();

const API_HASH       = requireEnv("TELEGRAM_API_HASH");
const SESSION_STR    = requireEnv("TELEGRAM_SESSION");
const APP_URL        = requireEnv("APP_URL").replace(/\/$/, "");
const WEBHOOK_SECRET = requireEnv("WEBHOOK_SECRET");
const PORT           = Number(process.env["PORT"] ?? "8080");

// ─── Structured logger (JSON lines) ──────────────────────────────────────────

function log(
  level: "info" | "warn" | "error",
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// ─── Telegram client ──────────────────────────────────────────────────────────

const client = new TelegramClient(
  new StringSession(SESSION_STR),
  API_ID,
  API_HASH,
  {
    connectionRetries: 100,   // keep retrying; GramJS handles the back-off
    retryDelay: 2000,
    autoReconnect: true,
    baseLogger: new Logger(LogLevel.NONE), // silence internal GramJS noise
  },
);

let connected = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a GramJS bigint-like value (native bigint, big-integer instance,
 * number, or string) to a plain decimal string. Returns null if conversion is
 * not possible.
 */
function toBigIntString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string"  && value.length > 0) return value;
  if (typeof value === "number"  && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  // big-integer objects have a .toString() that returns the decimal string
  if (
    typeof value === "object" &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const s = (value as { toString(): string }).toString();
    return /^-?\d+$/.test(s) ? s : null;
  }
  return null;
}

/**
 * Resolve a Telegram user by their id string, returning accessHash, username,
 * and firstName if available. Best-effort — returns null on any failure.
 */
async function resolveSenderEntity(userId: string): Promise<{
  accessHash: string | null;
  username: string | null;
  firstName: string | null;
} | null> {
  try {
    const entity = await client.getEntity(userId);
    if (!entity || !("id" in entity)) return null;
    return {
      accessHash:
        "accessHash" in entity && entity.accessHash != null
          ? toBigIntString(entity.accessHash)
          : null,
      username:
        "username" in entity && typeof entity.username === "string"
          ? entity.username
          : null,
      firstName:
        "firstName" in entity && typeof entity.firstName === "string"
          ? entity.firstName
          : null,
    };
  } catch {
    return null;
  }
}

// ─── Inbound: Telegram → App ──────────────────────────────────────────────────

/** Subscribe to incoming private DMs and relay them to the main app. */
function subscribeInbound(): void {
  client.addEventHandler(
    async (event: NewMessageEvent): Promise<void> => {
      try {
        // event.isPrivate comes from ChatGetter (inherited by EventCommon)
        if (!event.isPrivate) return;

        const msg = event.message;
        if (!msg) return;

        // Ignore outgoing (our own sends) and messages with no text
        if (msg.out) return;
        if (!msg.text) return;

        const senderId = toBigIntString(msg.senderId);
        if (!senderId) return;

        // Resolve full entity for accessHash / username / firstName
        const entity = await resolveSenderEntity(senderId);

        const payload = {
          userId:      senderId,
          accessHash:  entity?.accessHash  ?? null,
          username:    entity?.username    ?? null,
          firstName:   entity?.firstName   ?? null,
          text:        msg.text,
          messageId:   String(msg.id),
        };

        log("info", "Inbound DM received; relaying to app", {
          userId:    senderId,
          messageId: payload.messageId,
        });

        await relayToApp(payload);
      } catch (err) {
        log("error", "Error handling inbound message", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    new NewMessage({ incoming: true }),
  );

  log("info", "Subscribed to inbound private messages");
}

/**
 * Fire-and-forget relay to the main app.
 * Logs failures; never throws.
 */
async function relayToApp(payload: Record<string, unknown>): Promise<void> {
  const RELAY_TIMEOUT_MS = 5_000;
  const url = `${APP_URL}/api/inbound/telegram`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      log("warn", "App returned non-OK status on inbound relay", {
        status: res.status,
        url,
      });
    } else {
      log("info", "Inbound relay delivered", { status: res.status });
    }
  } catch (err) {
    log("error", "Failed to relay inbound message to app", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

/** Accumulate request body and return it as a UTF-8 string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function validateSecret(req: http.IncomingMessage): boolean {
  return req.headers["x-webhook-secret"] === WEBHOOK_SECRET;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** POST /send — send a DM on behalf of the app. */
async function handleSend(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!validateSecret(req)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch {
    sendJson(res, 400, { error: "Could not read request body" });
    return;
  }

  const parsed = safeParseJson(rawBody);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>)["userId"] !== "string" ||
    typeof (parsed as Record<string, unknown>)["text"] !== "string"
  ) {
    sendJson(res, 400, { error: "Invalid body: expected { userId, accessHash?, text }" });
    return;
  }

  const { userId, accessHash, text } = parsed as {
    userId: string;
    accessHash?: string | null;
    text: string;
  };

  try {
    let peer: Api.InputPeerUser;

    if (accessHash) {
      // Fast path: build the peer directly from the known accessHash
      peer = new Api.InputPeerUser({
        userId:     bigInt(userId),
        accessHash: bigInt(accessHash),
      });
    } else {
      // Fallback: ask GramJS to resolve the entity (requires prior contact)
      const resolved = await client.getInputEntity(userId);
      if (!(resolved instanceof Api.InputPeerUser)) {
        sendJson(res, 500, { error: "Could not resolve user entity — no accessHash provided and user is unknown" });
        return;
      }
      peer = resolved;
    }

    const result = await client.sendMessage(peer, { message: text });
    const msgId = toBigIntString(result.id) ?? null;

    log("info", "Outbound DM sent", { userId, messageId: msgId });
    sendJson(res, 200, { id: msgId });
  } catch (err) {
    log("error", "Failed to send Telegram message", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** GET /health */
function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  sendJson(res, 200, { ok: true, connected });
}

/** Main HTTP request dispatcher. */
async function requestHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = req.method ?? "";
  const url    = req.url    ?? "";

  try {
    if (method === "GET"  && url === "/health") { handleHealth(req, res); return; }
    if (method === "POST" && url === "/send")   { await handleSend(req, res); return; }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    log("error", "Unhandled error in request handler", {
      method,
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error" });
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("info", "Starting Telegram worker", { port: PORT, appUrl: APP_URL });

  log("info", "Connecting to Telegram...");
  await client.connect();
  connected = true;
  log("info", "Telegram connected");

  subscribeInbound();

  const server = http.createServer((req, res) => {
    void requestHandler(req, res).catch((err) => {
      log("error", "Unhandled promise rejection in requestHandler", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
    });
  });

  server.listen(PORT, () => {
    log("info", `HTTP server listening`, { port: PORT });
  });

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = async (signal: string): Promise<void> => {
    log("info", `Received ${signal}; shutting down gracefully`);
    connected = false;
    server.close(() => log("info", "HTTP server closed"));
    try {
      await client.disconnect();
      log("info", "Telegram client disconnected");
    } catch {
      // Best-effort — don't block shutdown
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });

  // Prevent the process from dying on unhandled rejections in event handlers
  process.on("unhandledRejection", (reason) => {
    log("error", "Unhandled promise rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg:   "Worker failed to start",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack    : undefined,
      ts:    new Date().toISOString(),
    }),
  );
  process.exit(1);
});

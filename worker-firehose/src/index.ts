/**
 * Radar — Bluesky Firehose (Jetstream) Worker
 *
 * Servicio Node persistente (Railway) que consume el firehose de Bluesky
 * (Jetstream) y detecta leads en tiempo real. Es el "cerebro" de la detección
 * de Bluesky: corre las capas baratas sobre TODO el stream y escribe `leads`
 * directo en Supabase (Approach A de docs/FIREHOSE.md). El downstream
 * (/api/process → notify → engage → charla) queda igual.
 *
 * Pipeline por evento:
 *   1. WebSocket Jetstream (solo `app.bsky.feed.post`)
 *   2. extractPostCreate → Capa 1 (idioma) + Capa 2 (keywords) = gatePost (puro)
 *   3. sobreviviente → resolver handle (cacheado) → buildLeadRow → insertLead
 *
 * Robustez:
 *   - Reconexión con backoff exponencial + jitter.
 *   - Cursor (`time_us`) persistido en `settings` (throttleado) → reanuda sin
 *     perder posts tras una caída/redeploy.
 *   - Keywords recargadas cada ~5 min; `classifier_paused` refrescado cada ~60 s.
 *
 * También expone `GET /health` (liveness para Railway). NO manda WhatsApp: el
 * aviso de tope de presupuesto lo manda `/api/process`.
 */

import http from "node:http";

import { WebSocket } from "ws";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Keyword } from "./filter/match";

import { loadEnv, WANTED_COLLECTION } from "./env";
import { log } from "./log";
import {
  createDbClient,
  insertLead,
  isClassifierPaused,
  loadKeywords,
} from "./db";
import { loadCursor, saveCursor } from "./cursor";
import { HandleResolver } from "./handle";
import { extractPostCreate, parseEvent } from "./jetstream";
import { buildLeadRow, gatePost } from "./lead";

// ─── Constantes de tiempo ──────────────────────────────────────────────────────

/** Cada cuánto recargar las keywords de la base. */
const KEYWORDS_REFRESH_MS = 5 * 60_000;
/** Cada cuánto refrescar el flag de presupuesto. */
const BUDGET_REFRESH_MS = 60_000;
/** Cada cuánto, como máximo, persistir el cursor (throttle). */
const CURSOR_SAVE_MS = 5_000;
/** Backoff de reconexión: base, tope y jitter. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/**
 * Buffer hacia atrás al reanudar (microsegundos = 5 s). Se le resta al cursor
 * guardado para no dejar un hueco si algún evento quedó a mitad de procesar; la
 * doble entrega la absorbe el dedup por `content_hash`. La doc del Jetstream
 * recomienda este margen para un replay sin baches.
 */
const CURSOR_REPLAY_BUFFER_US = 5_000_000;

const env = loadEnv();
const db: SupabaseClient = createDbClient(env.supabaseUrl, env.supabaseServiceRoleKey);
const resolver = new HandleResolver(env.atprotoApiUrl);

// ─── Estado mutable del worker ──────────────────────────────────────────────────

/** Keywords cacheadas (se recargan cada KEYWORDS_REFRESH_MS). */
let keywords: Keyword[] = [];
/** Flag de presupuesto cacheado (se refresca cada BUDGET_REFRESH_MS). */
let paused = false;
/** Último `time_us` visto (cursor en memoria). */
let lastTimeUs: number | null = null;
/** Último `time_us` ya persistido en la base. */
let savedTimeUs: number | null = null;
/** Marca de tiempo del último guardado de cursor (para el throttle). */
let lastCursorSaveAt = 0;
/** Conexión activa (para el `/health` y el shutdown). */
let ws: WebSocket | null = null;
/** Intentos de reconexión consecutivos (resetea al abrir con éxito). */
let reconnectAttempts = 0;

// Contadores acumulados (se loguean periódicamente y en el health).
const stats = {
  events: 0,
  posts: 0,
  discardedLang: 0,
  discardedKeywords: 0,
  discardedPaused: 0,
  discardedNoHandle: 0,
  inserted: 0,
  duplicates: 0,
};

// ─── Carga periódica de config (keywords + presupuesto) ──────────────────────────

async function refreshKeywords(): Promise<void> {
  try {
    keywords = await loadKeywords(db);
    log("info", "Keywords recargadas", { count: keywords.length });
  } catch (err) {
    log("error", "No se pudieron recargar las keywords (se conservan las anteriores)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function refreshBudget(): Promise<void> {
  try {
    const next = await isClassifierPaused(db);
    if (next !== paused) {
      log("info", "Cambió el estado del presupuesto", { paused: next });
    }
    paused = next;
  } catch (err) {
    log("error", "No se pudo refrescar classifier_paused (se conserva el anterior)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Persistencia throttleada del cursor ─────────────────────────────────────────

/**
 * Guarda el cursor si pasó el intervalo de throttle y hay algo nuevo.
 *
 * Se llama seguido (en cada evento) pero sólo escribe a la base como mucho cada
 * `CURSOR_SAVE_MS`, y sólo si el cursor avanzó respecto del último guardado.
 */
async function maybeSaveCursor(): Promise<void> {
  if (lastTimeUs === null) return;
  const now = Date.now();
  if (now - lastCursorSaveAt < CURSOR_SAVE_MS) return;
  if (lastTimeUs === savedTimeUs) return;

  lastCursorSaveAt = now;
  const toSave = lastTimeUs;
  try {
    await saveCursor(db, toSave);
    savedTimeUs = toSave;
  } catch (err) {
    log("warn", "No se pudo persistir el cursor (se reintenta luego)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Pipeline por evento ─────────────────────────────────────────────────────────

/**
 * Procesa una línea cruda del WebSocket: parsea, filtra y, si sobrevive,
 * resuelve el handle e inserta el lead. Nunca lanza (loguea y sigue): una sola
 * línea corrupta no debe tumbar el consumidor.
 */
async function handleMessage(data: string): Promise<void> {
  const event = parseEvent(data);
  if (!event) return;

  stats.events++;

  // Avanzar el cursor con CUALQUIER evento (aunque se descarte): así, si el
  // stream trae mucho ruido, igual reanudamos cerca de "ahora" tras una caída.
  const timeUs = typeof event.time_us === "number" ? event.time_us : null;
  if (timeUs !== null && (lastTimeUs === null || timeUs > lastTimeUs)) {
    lastTimeUs = timeUs;
  }

  const post = extractPostCreate(event);
  if (!post) {
    await maybeSaveCursor();
    return;
  }
  stats.posts++;

  // Capas 1 y 2 (puras, sin red). La mayoría de los posts muere acá.
  const gate = gatePost(post, keywords);
  if (!gate.passed) {
    if (gate.lang === "en") stats.discardedLang++;
    else stats.discardedKeywords++;
    await maybeSaveCursor();
    return;
  }

  // Presupuesto: si está pausado, NO insertamos (sólo contamos y logueamos).
  if (paused) {
    stats.discardedPaused++;
    log("info", "Lead descartado por presupuesto pausado", {
      did: post.did,
      matched: gate.matched,
    });
    await maybeSaveCursor();
    return;
  }

  // Sobreviviente: resolver handle (necesario para la URL → content_hash).
  const handle = await resolver.resolve(post.did);
  if (!handle) {
    stats.discardedNoHandle++;
    log("warn", "No se pudo resolver el handle; se omite el lead", { did: post.did });
    await maybeSaveCursor();
    return;
  }

  const row = buildLeadRow(post, handle, gate.lang, gate.matched);
  try {
    const isNew = await insertLead(db, row);
    if (isNew) {
      stats.inserted++;
      log("info", "Lead insertado", {
        did: post.did,
        handle,
        url: row.url,
        lang: gate.lang,
        matched: gate.matched,
      });
    } else {
      stats.duplicates++;
    }
  } catch (err) {
    log("error", "Falló la inserción del lead", {
      did: post.did,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await maybeSaveCursor();
}

// ─── Conexión al Jetstream con reconexión ────────────────────────────────────────

/** Arma la URL del Jetstream agregando el `cursor` si tenemos uno. */
function buildConnectUrl(): string {
  const base = env.jetstreamBaseUrl;
  if (lastTimeUs === null) return base;
  const cursor = Math.max(0, lastTimeUs - CURSOR_REPLAY_BUFFER_US);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}cursor=${cursor}`;
}

/** Calcula el delay de reconexión (backoff exponencial con jitter, topeado). */
function reconnectDelay(): number {
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
  const jitter = Math.random() * RECONNECT_BASE_MS;
  return exp + jitter;
}

/** Abre la conexión y cablea los handlers; reconecta solo al cerrarse. */
function connect(): void {
  const url = buildConnectUrl();
  log("info", "Conectando al Jetstream", {
    url,
    collection: WANTED_COLLECTION,
    resumingFrom: lastTimeUs,
  });

  const socket = new WebSocket(url);
  ws = socket;

  socket.on("open", () => {
    reconnectAttempts = 0;
    log("info", "Jetstream conectado");
  });

  socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    // El Jetstream envía JSON como texto; `ws` lo entrega como Buffer.
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data as Buffer).toString("utf8");
    void handleMessage(text).catch((err) => {
      log("error", "Error no controlado procesando un mensaje", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  socket.on("error", (err: Error) => {
    log("warn", "Error del WebSocket", { error: err.message });
    // El cierre dispara la reconexión; acá sólo logueamos.
  });

  socket.on("close", (code: number, reason: Buffer) => {
    ws = null;
    reconnectAttempts++;
    const delay = reconnectDelay();
    log("warn", "Jetstream desconectado; reintentando", {
      code,
      reason: reason.toString("utf8"),
      attempt: reconnectAttempts,
      delayMs: Math.round(delay),
    });
    setTimeout(connect, delay);
  });
}

// ─── Servidor HTTP (health) ──────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function startHealthServer(port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, {
        ok: true,
        connected: ws?.readyState === WebSocket.OPEN,
        paused,
        keywords: keywords.length,
        cursor: lastTimeUs,
        stats,
      });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  });
  server.listen(port, () => log("info", "HTTP server listening", { port }));
  return server;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? "8080");
  log("info", "Starting firehose worker", { jetstream: env.jetstreamBaseUrl, port });

  // Estado inicial: cursor persistido + keywords + presupuesto, antes de conectar.
  lastTimeUs = await loadCursor(db);
  savedTimeUs = lastTimeUs;
  log("info", "Cursor inicial", { cursor: lastTimeUs });

  await Promise.all([refreshKeywords(), refreshBudget()]);

  if (keywords.length === 0) {
    // No es fatal (podrían cargarse luego), pero sin keywords nada pasa la Capa 2.
    log("warn", "Arrancando sin keywords habilitadas: nada pasará el pre-filtro");
  }

  // Refrescos periódicos.
  setInterval(() => void refreshKeywords(), KEYWORDS_REFRESH_MS);
  setInterval(() => void refreshBudget(), BUDGET_REFRESH_MS);
  // Log de stats periódico, para ver el ritmo del stream en Railway.
  setInterval(() => log("info", "stats", { ...stats, cursor: lastTimeUs }), BUDGET_REFRESH_MS);

  const server = startHealthServer(port);
  connect();

  // Shutdown ordenado: persistir el cursor, cerrar socket y server.
  const shutdown = async (signal: string): Promise<void> => {
    log("info", `Received ${signal}; shutting down`);
    try {
      if (lastTimeUs !== null && lastTimeUs !== savedTimeUs) {
        await saveCursor(db, lastTimeUs);
      }
    } catch {
      // best-effort
    }
    try {
      ws?.close();
    } catch {
      // best-effort
    }
    server.close(() => log("info", "HTTP server closed"));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
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
      msg: "Worker failed to start",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      ts: new Date().toISOString(),
    }),
  );
  process.exit(1);
});

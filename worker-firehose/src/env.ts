/**
 * Carga y validación de variables de entorno del worker del firehose.
 *
 * Mismo patrón fail-fast que el worker de Telegram (`worker/src/index.ts`): si
 * falta una variable requerida, se loguea en una línea JSON y se corta el
 * proceso con código 1 — Railway reinicia el servicio y el error queda visible
 * en los logs en vez de explotar más tarde con un mensaje opaco.
 */

/** Instancia por defecto del Jetstream si no se setea `JETSTREAM_URL`. */
const DEFAULT_JETSTREAM_BASE =
  "wss://jetstream2.us-east.bsky.network/subscribe";

/** Colección del firehose que nos interesa: sólo posts del feed. */
export const WANTED_COLLECTION = "app.bsky.feed.post";

/** Host por defecto para resolver DID → handle (sin auth). Ver `.env.example`. */
const DEFAULT_ATPROTO_API_URL = "https://api.bsky.app";

/** Sale del proceso tras loguear un fatal en una sola línea JSON. */
function fatal(msg: string, extra?: Record<string, unknown>): never {
  console.error(
    JSON.stringify({ level: "fatal", msg, ts: new Date().toISOString(), ...extra }),
  );
  process.exit(1);
}

/** Devuelve la env var o corta el proceso si falta/está vacía. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) fatal(`Missing required env var: ${name}`);
  return value;
}

/**
 * Construye la URL del Jetstream a partir de `JETSTREAM_URL` (opcional).
 *
 * - Sin `JETSTREAM_URL`: usa la instancia por defecto y le agrega
 *   `?wantedCollections=app.bsky.feed.post`.
 * - Con `JETSTREAM_URL` sin query string: le agrega el `wantedCollections`.
 * - Con `JETSTREAM_URL` que ya trae query string: se respeta tal cual (el
 *   operador sabe lo que hace).
 *
 * El `cursor` NO se fija acá: se agrega dinámicamente en cada (re)conexión
 * porque cambia con el último evento procesado.
 */
export function buildJetstreamBaseUrl(): string {
  const raw = process.env["JETSTREAM_URL"]?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_JETSTREAM_BASE;
  if (base.includes("?")) return base;
  return `${base}?wantedCollections=${WANTED_COLLECTION}`;
}

/** Configuración resuelta del worker. */
export interface WorkerEnv {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** URL base del Jetstream, sin el parámetro `cursor`. */
  jetstreamBaseUrl: string;
  /** Host del API de atproto para resolver handles (sin barra final). */
  atprotoApiUrl: string;
}

/** Lee y valida la configuración del entorno (fail-fast si falta algo). */
export function loadEnv(): WorkerEnv {
  const supabaseUrl = requireEnv("SUPABASE_URL").replace(/\/$/, "");
  const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const atprotoApiUrl = (
    process.env["ATPROTO_API_URL"]?.trim() || DEFAULT_ATPROTO_API_URL
  ).replace(/\/$/, "");

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    jetstreamBaseUrl: buildJetstreamBaseUrl(),
    atprotoApiUrl,
  };
}

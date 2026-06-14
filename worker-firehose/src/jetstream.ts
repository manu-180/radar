/**
 * Tipos y parsing de los eventos del Jetstream de Bluesky.
 *
 * Verificado contra la doc oficial de `bluesky-social/jetstream` (ver README).
 * El Jetstream emite un objeto JSON por evento; sólo nos interesan los `commit`
 * con `operation:'create'` sobre la colección `app.bsky.feed.post`.
 *
 * Shape de un evento `commit` (de la doc oficial):
 * ```json
 * {
 *   "did": "did:plc:...",
 *   "time_us": 1725911162329308,
 *   "kind": "commit",
 *   "commit": {
 *     "rev": "3l3qo2vutsw2b",
 *     "operation": "create",
 *     "collection": "app.bsky.feed.post",
 *     "rkey": "3l3qo2vuowo2b",
 *     "record": { "$type": "app.bsky.feed.post", "text": "...", "createdAt": "..." },
 *     "cid": "bafy..."
 *   }
 * }
 * ```
 */

/** Record de un post (`app.bsky.feed.post`); sólo tipamos lo que usamos. */
export interface JetstreamPostRecord {
  $type?: string;
  /** Texto principal del post (requerido por el lexicon). */
  text?: unknown;
  /** Timestamp declarado por el cliente (ISO 8601, requerido por el lexicon). */
  createdAt?: unknown;
  /** Idiomas declarados por el autor; informativo, no se usa para filtrar. */
  langs?: unknown;
}

/** Parte `commit` de un evento del Jetstream. */
export interface JetstreamCommit {
  operation?: unknown;
  collection?: unknown;
  rkey?: unknown;
  rev?: unknown;
  cid?: unknown;
  record?: JetstreamPostRecord;
}

/** Evento del Jetstream (cualquier `kind`). */
export interface JetstreamEvent {
  did?: unknown;
  /** Cursor: microsegundos unix del evento. */
  time_us?: unknown;
  kind?: unknown;
  commit?: JetstreamCommit;
}

/**
 * Un post create ya extraído y validado de un evento del Jetstream.
 *
 * Es lo mínimo que necesita el pipeline aguas abajo (filtro + mapeo a lead).
 */
export interface PostCreate {
  /** DID del autor (repo). */
  did: string;
  /** Record key del post. */
  rkey: string;
  /** Texto del post. */
  text: string;
  /** `createdAt` del record en ISO 8601, o `null` si no vino/era inválido. */
  createdAt: string | null;
  /** Cursor del evento (microsegundos unix), o `null` si no vino. */
  timeUs: number | null;
  /** El evento original completo, para guardar en `leads.raw`. */
  raw: JetstreamEvent;
}

/** Parsea de forma segura una línea de texto del WebSocket a un evento. */
export function parseEvent(data: string): JetstreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === "object") return parsed as JetstreamEvent;
    return null;
  } catch {
    return null;
  }
}

/** Devuelve `time_us` como número si el evento lo trae, o `null`. */
export function readTimeUs(event: JetstreamEvent): number | null {
  const t = event.time_us;
  return typeof t === "number" && Number.isFinite(t) ? t : null;
}

/**
 * Extrae un post create de un evento, o `null` si el evento no lo es.
 *
 * Filtra por `kind:'commit'`, `commit.operation:'create'` y
 * `commit.collection:'app.bsky.feed.post'`, y exige un `did`, un `rkey` y un
 * `text` no vacío (un post sin texto no puede ser un lead). El resto del evento
 * se conserva en `raw`.
 */
export function extractPostCreate(event: JetstreamEvent): PostCreate | null {
  if (event.kind !== "commit") return null;

  const commit = event.commit;
  if (!commit || typeof commit !== "object") return null;
  if (commit.operation !== "create") return null;
  if (commit.collection !== "app.bsky.feed.post") return null;

  const did = event.did;
  const rkey = commit.rkey;
  if (typeof did !== "string" || did.length === 0) return null;
  if (typeof rkey !== "string" || rkey.length === 0) return null;

  const record = commit.record;
  if (!record || typeof record !== "object") return null;

  const text = typeof record.text === "string" ? record.text : "";
  if (text.trim().length === 0) return null;

  const createdAt =
    typeof record.createdAt === "string" && record.createdAt.length > 0
      ? record.createdAt
      : null;

  return {
    did,
    rkey,
    text,
    createdAt,
    timeUs: readTimeUs(event),
    raw: event,
  };
}

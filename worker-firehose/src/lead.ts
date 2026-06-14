/**
 * Mapeo de un post del firehose a una fila de `leads`, idéntico al search-poll.
 *
 * El punto crítico es el **dedup perfecto** entre este worker y el adaptador de
 * Bluesky del search-poll (`lib/sources/bluesky.ts`): ambos corren en paralelo
 * durante la transición y el `content_hash` es el índice único que evita el
 * doble proceso. Por eso este módulo reconstruye un {@link RawItem} con
 * EXACTAMENTE los mismos `title`, `body` y `url` que `toRawItem` del adaptador y
 * calcula el hash con la misma función {@link contentHash}. Si el `title`
 * divergiera (p. ej. usando `''`), el hash sería otro y el mismo post entraría
 * dos veces.
 *
 * `content_hash = sha256(normalize(title + ' ' + body + ' ' + url))` — `raw` y el
 * resto de los campos NO entran al hash, así que da igual que el `raw` del
 * firehose tenga otra forma que el del search-poll.
 */

import { contentHash, detectLang } from "./filter/normalize";
import { prefilter, type Keyword } from "./filter/match";

import type { LeadRow } from "./types";
import type { PostCreate } from "./jetstream";

/** Slug de la fuente: comparte el del search-poll para que el outreach funcione. */
const SOURCE = "bluesky" as const;

/** Largo máximo del título derivado de la primera línea (igual que el adaptador). */
const TITLE_MAX_LENGTH = 120;

/**
 * Item reconstruido como lo arma `toRawItem` del search-poll: lo justo para
 * calcular el `content_hash` (title/body/url) y armar la fila. Espejo local del
 * `RawItem` del app (no se importa para mantener el worker autocontenido).
 */
interface PollItem {
  externalId: string;
  title: string;
  body: string;
  url: string;
  author: string;
  postedAt: string | null;
  raw: unknown;
  contact: {
    channel: "bluesky";
    key: string;
    ref: { did: string };
    handle: string;
  };
}

/**
 * Recorta `text` a `max` caracteres agregando una elipsis si lo excede.
 *
 * Copia EXACTA de `truncate` en `lib/sources/bluesky.ts` (incluida la elipsis
 * `…` de un solo carácter) — cualquier diferencia rompería el `content_hash`.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Construye la URI `at://` del post: el `external_id` del lead.
 *
 * Es la misma forma que expone `searchPosts` en `post.uri`, así que coincide con
 * el `external_id` que persiste el search-poll → cubre también el índice único
 * `(source, external_id)`.
 */
export function buildAtUri(did: string, rkey: string): string {
  return `at://${did}/app.bsky.feed.post/${rkey}`;
}

/**
 * Reconstruye el {@link RawItem} del post tal como lo arma `toRawItem` del
 * adaptador de Bluesky, dado el texto, el handle y el rkey.
 *
 * Replica al pie de la letra:
 * - `title`: primera línea no vacía, recortada a {@link TITLE_MAX_LENGTH}; si no
 *   hay texto, la constante `"Bluesky post"`.
 * - `body`: el texto completo (ya `trim`eado por quien llama).
 * - `url`: `https://bsky.app/profile/{handle}/post/{rkey}` (igual que el adaptador).
 */
export function buildRawItem(
  text: string,
  handle: string,
  rkey: string,
  post: PostCreate,
): PollItem {
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n").find((line) => line.length > 0) ?? "";
  const did = post.did;

  return {
    externalId: buildAtUri(did, rkey),
    title: firstLine ? truncate(firstLine, TITLE_MAX_LENGTH) : "Bluesky post",
    body: trimmed,
    url: `https://bsky.app/profile/${handle}/post/${rkey}`,
    author: handle,
    postedAt: post.createdAt,
    raw: post.raw,
    contact: {
      channel: "bluesky",
      key: did,
      ref: { did },
      handle: `@${handle}`,
    },
  };
}

/**
 * Deriva el `title` del post tal como `toRawItem` del adaptador: primera línea
 * no vacía recortada, o `"Bluesky post"` si no hay texto. Aislado para poder
 * computar el idioma con el mismo input que el search-poll sin armar la URL
 * (que necesita el handle).
 */
function deriveTitle(text: string): string {
  const firstLine = text.trim().split("\n").find((line) => line.length > 0) ?? "";
  return firstLine ? truncate(firstLine, TITLE_MAX_LENGTH) : "Bluesky post";
}

/** Resultado de correr las capas baratas (idioma + keywords) sobre un post. */
export interface GateResult {
  /** `true` si el post sobrevive y hay que resolver su handle e insertarlo. */
  passed: boolean;
  /** Idioma detectado, para reusar al armar la fila (no recomputar). */
  lang: "es" | "en" | "other";
  /** Keywords de inclusión que matchearon (vacío si no pasó). */
  matched: string[];
  /** Motivo legible de la decisión, para logs. */
  reason: string;
}

/**
 * Capas 1 y 2 sobre un post, SIN tocar red (no necesita el handle).
 *
 * Capa 1 (idioma): `detectLang` sobre `title + ' ' + body` — el MISMO input que
 * usa el search-poll en `app/api/poll/[source]/route.ts` (no sobre el texto
 * crudo), para que la decisión sea idéntica. Se descarta `'en'`; se conservan
 * `'es'` y `'other'` (posts cortos que franc no clasifica).
 *
 * Capa 2 (keywords): `prefilter({title:'', body:text}, lang, keywords)` — tal
 * como pide la spec del worker (título vacío en el match). El `title` real casi
 * siempre repite la primera línea del body, así que no se pierde señal.
 *
 * Corre ANTES de resolver el handle a propósito: la inmensa mayoría de los posts
 * del stream se descartan acá, así evitamos un request por cada uno.
 */
export function gatePost(post: PostCreate, keywords: Keyword[]): GateResult {
  const title = deriveTitle(post.text);
  const lang = detectLang(`${title} ${post.text.trim()}`);

  if (lang === "en") {
    return { passed: false, lang, matched: [], reason: "Idioma inglés: descartado" };
  }

  // Capa 2: la spec del worker indica matchear con título vacío.
  const result = prefilter({ title: "", body: post.text }, lang, keywords);
  return { passed: result.passed, lang, matched: result.matched, reason: result.reason };
}

/**
 * Arma la fila de `leads` de un post que ya pasó {@link gatePost}.
 *
 * Reconstruye el {@link RawItem} idéntico al del search-poll (mismo `title`,
 * `body`, `url`) y calcula `content_hash` con la misma función → dedup perfecto.
 * Los campos de contacto y de cola son los que fija la spec del worker.
 *
 * @param post      El post create extraído del evento.
 * @param handle    Handle ya resuelto del autor (sin `@`).
 * @param lang      Idioma detectado en {@link gatePost} (se reusa, no se recomputa).
 * @param matched   Keywords que matchearon en {@link gatePost}.
 */
export function buildLeadRow(
  post: PostCreate,
  handle: string,
  lang: "es" | "en" | "other",
  matched: string[],
): LeadRow {
  const item = buildRawItem(post.text, handle, post.rkey, post);
  return {
    source: SOURCE,
    external_id: item.externalId,
    content_hash: contentHash(item),
    title: item.title,
    body: item.body,
    url: item.url,
    author: item.author,
    lang,
    posted_at: item.postedAt,
    raw: item.raw,
    prefilter_matched: matched,
    llm_status: "pending",
    notify_status: "pending",
    contact_channel: "bluesky",
    contact_key: post.did,
    contact_ref: { did: post.did },
    contact_handle: `@${handle}`,
  };
}

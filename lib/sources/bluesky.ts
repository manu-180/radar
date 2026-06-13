/**
 * Adaptador de fuente: Bluesky (AT Protocol).
 *
 * Bluesky es la fuente social de mejor relación valor/esfuerzo: la API de
 * búsqueda es gratis y **sin autenticación**. Este adaptador busca posts
 * recientes que mencionan las `queries` configuradas (ej. "necesito un
 * desarrollador") y los normaliza a {@link RawItem}.
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords
 * ni clasifica con IA. El polling es incremental — el cursor guarda el
 * `indexedAt` (ISO) del post más nuevo ya visto y, en cada corrida, se
 * descartan los posts con `indexedAt <= lastIndexedAt` y se deduplica por `uri`.
 *
 * ## Sobre la paginación
 *
 * El plan original contemplaba paginar `searchPosts` con el `cursor` de la API.
 * Verificado contra la API real: el endpoint **sin auth solo sirve la primera
 * página** — cualquier request con el parámetro `cursor` responde `403`. Por
 * eso este adaptador trae una sola página (hasta {@link POSTS_PER_QUERY} posts)
 * por query, ordenada por `latest`. Con el polling corriendo seguido, 100 posts
 * recientes por query alcanzan de sobra entre corridas; paginar requeriría una
 * app password de Bluesky, que el plan excluye explícitamente.
 *
 * Además, el host `public.api.bsky.app` (el "oficial" sin auth) ahora responde
 * `403` a `searchPosts`; el host `api.bsky.app` sí lo sirve sin credenciales.
 */

import { z } from "zod";

import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { registerSource } from "@/lib/sources/registry";
import type {
  FetchResult,
  RawItem,
  SourceAdapter,
  SourceCursor,
} from "@/lib/sources/types";

/**
 * Endpoint de búsqueda de posts (sin auth).
 *
 * Se usa el host `api.bsky.app`: `public.api.bsky.app` responde `403` a
 * `searchPosts` (bloqueado a nivel CDN). Ver el encabezado del módulo.
 */
const SEARCH_POSTS_URL = "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts";

/** `User-Agent` propio para identificar al cliente ante la API. */
const USER_AGENT = "LeadDetector/1.0 (+bluesky-source-adapter)";

/** Posts a pedir por query (máximo que admite el endpoint sin paginar). */
const POSTS_PER_QUERY = 100;

/** Largo máximo del título derivado de la primera línea del post. */
const TITLE_MAX_LENGTH = 120;

/** Pausa entre queries para no golpear la API de Bluesky. */
const PAUSE_BETWEEN_QUERIES_MS = 1_000;

/** Config propia de la fuente Bluesky (columna `sources.config`). */
const configSchema = z.object({
  /** Frases a buscar entre los posts recientes de Bluesky. */
  queries: z.array(z.string()),
});

type BlueskyConfig = z.infer<typeof configSchema>;

/** Forma parcial del autor de un post, con los campos que usamos. */
interface BlueskyAuthor {
  /** DID del autor: clave de contacto estable para DMs (v2). */
  did?: string | null;
  handle?: string | null;
}

/** Forma parcial del `record` de un post (`app.bsky.feed.post`). */
interface BlueskyRecord {
  text?: string | null;
}

/** Forma parcial de un post de la respuesta de `searchPosts`. */
interface BlueskyPost {
  uri: string;
  author?: BlueskyAuthor | null;
  record?: BlueskyRecord | null;
  indexedAt?: string | null;
}

/** Respuesta del endpoint `searchPosts`. */
interface SearchPostsResponse {
  posts?: BlueskyPost[];
}

const log = createLogger({ source: "bluesky" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cursor de esta fuente: el `indexedAt` (ISO) del post más nuevo ya visto. */
function readLastIndexedAt(cursor: SourceCursor): string | null {
  const last = cursor.lastIndexedAt;
  return typeof last === "string" && last.length > 0 ? last : null;
}

/** Convierte un `indexedAt` ISO a epoch ms; `null` si falta o no parsea. */
function toEpoch(indexedAt: string | null | undefined): number | null {
  if (!indexedAt) return null;
  const ms = Date.parse(indexedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Recorta `text` a `max` caracteres agregando una elipsis si lo excede. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Busca posts recientes que mencionan `query`, ordenados del más nuevo al más viejo. */
async function searchPosts(query: string): Promise<BlueskyPost[]> {
  const params = new URLSearchParams({
    q: query,
    sort: "latest",
    limit: String(POSTS_PER_QUERY),
  });
  const response = await fetchWithRetry(`${SEARCH_POSTS_URL}?${params}`, {
    userAgent: USER_AGENT,
  });
  const data = (await response.json()) as SearchPostsResponse;
  return Array.isArray(data.posts) ? data.posts : [];
}

/**
 * Mapea un post de Bluesky a la forma neutral {@link RawItem}.
 *
 * El `rkey` (último segmento de la `uri` `at://...`) y el handle del autor
 * arman la URL pública del post en bsky.app.
 */
function toRawItem(post: BlueskyPost): RawItem {
  const text = (post.record?.text ?? "").trim();
  const firstLine = text.split("\n").find((line) => line.length > 0) ?? "";
  const handle = post.author?.handle ?? null;
  const did = post.author?.did ?? null;
  const rkey = post.uri.split("/").pop() ?? "";

  // Contacto (v2): el autor es alcanzable por DM si tenemos su DID. La clave de
  // ruteo es el DID; el handle es sólo display.
  const contact: RawItem["contact"] = did
    ? {
        channel: "bluesky",
        key: did,
        ref: { did },
        handle: handle ? `@${handle}` : null,
      }
    : null;

  return {
    externalId: post.uri,
    title: firstLine ? truncate(firstLine, TITLE_MAX_LENGTH) : "Bluesky post",
    body: text,
    url:
      handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : "",
    author: handle,
    postedAt: post.indexedAt ?? null,
    raw: post,
    contact,
  };
}

/**
 * Adaptador de Bluesky.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const blueskyAdapter: SourceAdapter = {
  slug: "bluesky",
  displayName: "Bluesky",
  configSchema,

  async fetchItems(rawConfig: unknown, cursor: SourceCursor): Promise<FetchResult> {
    const config: BlueskyConfig = configSchema.parse(rawConfig);
    const lastIndexedAt = readLastIndexedAt(cursor);
    const floor = toEpoch(lastIndexedAt);

    // Dedup por uri: un post puede matchear varias queries.
    const seen = new Map<string, BlueskyPost>();
    let newestEpoch = floor ?? 0;
    let newestIso = lastIndexedAt;
    let failures = 0;

    for (let i = 0; i < config.queries.length; i++) {
      const query = config.queries[i];
      if (i > 0) await sleep(PAUSE_BETWEEN_QUERIES_MS);

      let posts: BlueskyPost[];
      try {
        posts = await searchPosts(query);
      } catch (err) {
        failures++;
        log.warn("Falló una query, se continúa con el resto", {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let kept = 0;
      for (const post of posts) {
        if (!post.uri || seen.has(post.uri)) continue;

        const epoch = toEpoch(post.indexedAt);
        // Ya procesado en una corrida anterior: el cursor lo deja afuera.
        if (floor !== null && epoch !== null && epoch <= floor) continue;

        seen.set(post.uri, post);
        kept++;
        if (epoch !== null && epoch > newestEpoch) {
          newestEpoch = epoch;
          newestIso = post.indexedAt ?? newestIso;
        }
      }

      log.info("Query procesada", { query, posts: posts.length, kept });
    }

    // Si fallaron todas las queries es un fallo real de la fuente, no una
    // corrida vacía legítima.
    if (failures > 0 && failures === config.queries.length) {
      throw new Error(
        `bluesky: fallaron las ${failures} query(s) configuradas.`,
      );
    }

    const items = [...seen.values()]
      .map(toRawItem)
      .filter((item) => item.body.length > 0 && item.url.length > 0);

    log.info("Corrida de polling completa", {
      items: items.length,
      lastIndexedAt: newestIso,
    });

    // Sin ningún post visto (cursor y corrida vacíos) se devuelve `{}` para
    // que la próxima corrida vuelva a arrancar sin floor.
    const nextCursor: SourceCursor = newestIso
      ? { lastIndexedAt: newestIso }
      : {};

    return { items, cursor: nextCursor };
  },
};

registerSource(blueskyAdapter);

/**
 * Adaptador de fuente: Hacker News.
 *
 * Primer adaptador concreto del patrón de fuentes. Trae comentarios recientes
 * de HN usando la API pública de Algolia HN Search (gratis, sin auth) y los
 * normaliza a {@link RawItem}. Cubre dos vetas:
 *
 *  1. Comentarios que mencionan las `keywordQueries` configuradas.
 *  2. Si `includeWhoIsHiring` está activo, las respuestas "SEEKING FREELANCER"
 *     del hilo mensual de freelancers ("Ask HN: Freelancer? Seeking freelancer?").
 *
 * El adaptador **solo trae y normaliza**: no filtra por keywords del pre-filtro
 * ni clasifica con IA. El polling es incremental — el cursor guarda el mayor
 * `created_at_i` visto para no re-traer lo mismo en cada corrida.
 */

import { z } from "zod";

import { normalizeText } from "@/lib/filter/normalize";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { registerSource } from "@/lib/sources/registry";
import type {
  FetchResult,
  RawItem,
  SourceAdapter,
  SourceCursor,
} from "@/lib/sources/types";

/** Base de la API de Algolia HN Search. */
const ALGOLIA_BASE = "https://hn.algolia.com/api/v1";

/** `User-Agent` propio para identificar al cliente ante la API. */
const USER_AGENT = "LeadDetector/1.0 (+hackernews-source-adapter)";

/**
 * Ventana de arranque cuando el cursor está vacío: ~26 h hacia atrás.
 *
 * Es algo más que el intervalo de polling típico para tolerar corridas
 * salteadas sin perder comentarios.
 */
const LOOKBACK_SECONDS = 26 * 60 * 60;

/** Cantidad de hits a pedir por query de comentarios. */
const COMMENTS_PER_PAGE = 200;

/** Largo máximo del título derivado de la primera línea del comentario. */
const TITLE_MAX_LENGTH = 120;

/** Config propia de la fuente Hacker News (columna `sources.config`). */
const configSchema = z.object({
  /** Queries de texto a buscar entre los comentarios recientes de HN. */
  keywordQueries: z.array(z.string()),
  /** Si se incluye el hilo mensual de freelancers ("Seeking freelancer"). */
  includeWhoIsHiring: z.boolean(),
});

type HackerNewsConfig = z.infer<typeof configSchema>;

/** Forma parcial de un hit de Algolia, con sólo los campos que usamos. */
interface AlgoliaHit {
  objectID: string;
  comment_text?: string | null;
  title?: string | null;
  author?: string | null;
  created_at?: string | null;
  created_at_i?: number | null;
}

/** Respuesta de los endpoints de búsqueda de Algolia. */
interface AlgoliaResponse {
  hits?: AlgoliaHit[];
}

const log = createLogger({ source: "hackernews" });

/** Cursor de esta fuente: el mayor `created_at_i` (unix seg) ya procesado. */
function readCursorFloor(cursor: SourceCursor): number {
  const last = cursor.lastCreatedAt;
  if (typeof last === "number" && Number.isFinite(last)) return last;
  return Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
}

/** GET a Algolia con reintentos; devuelve siempre un array de hits. */
async function algoliaGet(path: string, params: Record<string, string>): Promise<AlgoliaHit[]> {
  const url = `${ALGOLIA_BASE}/${path}?${new URLSearchParams(params).toString()}`;
  const response = await fetchWithRetry(url, { userAgent: USER_AGENT });
  const data = (await response.json()) as AlgoliaResponse;
  return Array.isArray(data.hits) ? data.hits : [];
}

/** Comentarios posteriores a `floor` que mencionan `query`. */
function searchComments(query: string, floor: number): Promise<AlgoliaHit[]> {
  return algoliaGet("search_by_date", {
    tags: "comment",
    query,
    numericFilters: `created_at_i>${floor}`,
    hitsPerPage: String(COMMENTS_PER_PAGE),
  });
}

/**
 * Ubica el `objectID` del hilo mensual de freelancers más reciente.
 *
 * Devuelve `null` si no se encuentra ninguno: en ese caso simplemente se omite
 * la veta "who is hiring" sin abortar la corrida.
 */
async function findFreelancerThread(): Promise<string | null> {
  const hits = await algoliaGet("search", {
    query: "Ask HN Freelancer Seeking freelancer",
    tags: "story",
    hitsPerPage: "5",
  });
  const candidates = hits
    .filter((hit) => (hit.title ?? "").toLowerCase().includes("freelancer"))
    .sort((a, b) => (b.created_at_i ?? 0) - (a.created_at_i ?? 0));

  if (candidates.length === 0) {
    log.warn("No se encontró el hilo mensual de freelancers");
    return null;
  }
  return candidates[0].objectID;
}

/** Todos los comentarios de un hilo (`story_<id>`). */
function fetchThreadComments(storyId: string): Promise<AlgoliaHit[]> {
  return algoliaGet("search", {
    tags: `comment,story_${storyId}`,
    hitsPerPage: "1000",
  });
}

/** Tabla mínima de entidades HTML que aparecen en los comentarios de HN. */
const NAMED_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Decodifica entidades HTML numéricas y las nombradas más comunes. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;|&gt;|&quot;|&apos;|&nbsp;/g, (e) => NAMED_ENTITIES[e])
    .replace(/&amp;/g, "&"); // último: evita re-decodificar entidades escapadas
}

/**
 * Convierte el HTML de un comentario de HN a texto plano.
 *
 * Los `<p>` pasan a saltos de línea dobles, el resto de tags se borra y las
 * entidades se decodifican. El resultado queda con líneas recortadas y sin
 * espaciado redundante.
 */
function stripHtml(html: string): string {
  return decodeEntities(
    html.replace(/<\s*\/?\s*p\s*\/?\s*>/gi, "\n\n").replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Recorta `text` a `max` caracteres agregando una elipsis si lo excede. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Mapea un hit de Algolia a la forma neutral {@link RawItem}. */
function toRawItem(hit: AlgoliaHit): RawItem {
  const body = stripHtml(hit.comment_text ?? "");
  const firstLine = body.split("\n").find((line) => line.length > 0) ?? "";
  return {
    externalId: hit.objectID,
    title: firstLine ? truncate(firstLine, TITLE_MAX_LENGTH) : "HN Freelancer thread",
    body,
    url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    author: hit.author ?? null,
    postedAt: hit.created_at ?? null,
    raw: hit,
  };
}

/**
 * Adaptador de Hacker News.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const hackerNewsAdapter: SourceAdapter = {
  slug: "hackernews",
  displayName: "Hacker News",
  configSchema,

  async fetchItems(rawConfig: unknown, cursor: SourceCursor): Promise<FetchResult> {
    const config: HackerNewsConfig = configSchema.parse(rawConfig);
    const floor = readCursorFloor(cursor);

    // Dedup por objectID: un comentario puede matchear varias queries.
    const seen = new Map<string, AlgoliaHit>();
    let maxCreatedAt = floor;

    const collect = (hit: AlgoliaHit): void => {
      if (!hit.objectID || seen.has(hit.objectID)) return;
      seen.set(hit.objectID, hit);
      if (typeof hit.created_at_i === "number") {
        maxCreatedAt = Math.max(maxCreatedAt, hit.created_at_i);
      }
    };

    // Veta 1: comentarios recientes por keyword query.
    for (const query of config.keywordQueries) {
      const hits = await searchComments(query, floor);
      hits.forEach(collect);
      log.info("Query de comentarios procesada", { query, hits: hits.length });
    }

    // Veta 2: respuestas "SEEKING FREELANCER" del hilo mensual.
    if (config.includeWhoIsHiring) {
      const storyId = await findFreelancerThread();
      if (storyId) {
        const comments = await fetchThreadComments(storyId);
        const seeking = comments.filter((hit) => {
          if (typeof hit.created_at_i === "number" && hit.created_at_i <= floor) {
            return false;
          }
          return normalizeText(stripHtml(hit.comment_text ?? "")).startsWith(
            "seeking freelancer",
          );
        });
        seeking.forEach(collect);
        log.info("Hilo de freelancers procesado", {
          storyId,
          comments: comments.length,
          seekingFreelancer: seeking.length,
        });
      }
    }

    const items = [...seen.values()]
      .map(toRawItem)
      .filter((item) => item.body.length > 0);

    log.info("Corrida de polling completa", {
      items: items.length,
      lastCreatedAt: maxCreatedAt,
    });

    return { items, cursor: { lastCreatedAt: maxCreatedAt } };
  },
};

registerSource(hackerNewsAdapter);

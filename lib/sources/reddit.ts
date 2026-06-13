/**
 * Adaptador de fuente: Reddit.
 *
 * Reddit es la fuente de mayor volumen de pedidos explícitos de "busco
 * developer": subreddits como r/forhire concentran posts con flair `[Hiring]`.
 * Este adaptador recorre los subreddits configurados, trae los posts nuevos vía
 * los endpoints JSON públicos (sin auth) y los normaliza a {@link RawItem}.
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords
 * ni clasifica con IA. El polling es incremental — el cursor guarda el mayor
 * `created_utc` visto para no re-traer lo mismo en cada corrida.
 *
 * Requisito crítico de Reddit: cada request debe mandar un `User-Agent`
 * descriptivo (`env.REDDIT_USER_AGENT`). Un User-Agent genérico es bloqueado.
 */

import { z } from "zod";

import { env } from "@/lib/env";
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

/** Cantidad de posts a pedir por subreddit (máximo que admite el endpoint). */
const POSTS_PER_SUBREDDIT = 100;

/**
 * Ventana de arranque cuando el cursor está vacío: ~26 h hacia atrás.
 *
 * Es algo más que el intervalo de polling típico para tolerar corridas
 * salteadas sin perder posts.
 */
const LOOKBACK_SECONDS = 26 * 60 * 60;

/** Pausa entre subreddits para no golpear la API de Reddit. */
const PAUSE_BETWEEN_SUBREDDITS_MS = 2_000;

/** Config propia de la fuente Reddit (columna `sources.config`). */
const configSchema = z.object({
  /** Subreddits a monitorear (sin el prefijo `r/`). */
  subreddits: z.array(z.string()),
  /**
   * Si sólo se conservan los posts con flair de "contratando": el flair
   * contiene `hiring` y **no** contiene `for hire`.
   */
  hiringFlairOnly: z.boolean(),
});

type RedditConfig = z.infer<typeof configSchema>;

/** Forma parcial de los `data` de un post (`t3`), con los campos que usamos. */
interface RedditPostData {
  name: string;
  title?: string | null;
  selftext?: string | null;
  permalink?: string | null;
  author?: string | null;
  created_utc?: number | null;
  link_flair_text?: string | null;
}

/** Un child del listing; sólo nos interesan los de tipo `t3` (posts). */
interface RedditChild {
  kind: string;
  data: RedditPostData;
}

/** Respuesta del endpoint `new.json` de un subreddit. */
interface RedditListing {
  data?: {
    children?: RedditChild[];
  };
}

const log = createLogger({ source: "reddit" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cursor de esta fuente: el mayor `created_utc` (unix seg) ya procesado. */
function readCursorFloor(cursor: SourceCursor): number {
  const last = cursor.lastCreatedUtc;
  if (typeof last === "number" && Number.isFinite(last)) return last;
  return Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
}

/** Trae los posts nuevos de un subreddit vía `new.json`. */
async function fetchSubreddit(subreddit: string): Promise<RedditPostData[]> {
  const url =
    `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json` +
    `?limit=${POSTS_PER_SUBREDDIT}`;
  const response = await fetchWithRetry(url, {
    userAgent: env.REDDIT_USER_AGENT,
  });
  const listing = (await response.json()) as RedditListing;
  const children = listing.data?.children ?? [];
  return children
    .filter((child) => child.kind === "t3" && child.data)
    .map((child) => child.data);
}

/**
 * Decide si un post pasa el filtro de flair de "contratando".
 *
 * El flair se normaliza para comparar sin importar casing ni acentos. En
 * subreddits como r/forhire conviven `[Hiring]` (contratan, lo queremos) y
 * `[For Hire]` (se ofrecen, lo descartamos): ambos contienen el sustring
 * "hir", así que se exige `hiring` y se descarta explícitamente `for hire`.
 */
function hasHiringFlair(post: RedditPostData): boolean {
  const flair = normalizeText(post.link_flair_text ?? "");
  return flair.includes("hiring") && !flair.includes("for hire");
}

/** Mapea los `data` de un post de Reddit a la forma neutral {@link RawItem}. */
function toRawItem(post: RedditPostData): RawItem {
  const author = post.author ?? null;

  // Contacto (v2): se puede escribir al autor por DM salvo que la cuenta esté
  // borrada/suspendida (`[deleted]`). La clave de ruteo es el username.
  const contact: RawItem["contact"] =
    author && author !== "[deleted]"
      ? { channel: "reddit", key: author, ref: {}, handle: `u/${author}` }
      : null;

  return {
    externalId: post.name,
    title: post.title ?? "",
    body: post.selftext ?? "",
    url: `https://www.reddit.com${post.permalink ?? ""}`,
    author,
    postedAt:
      typeof post.created_utc === "number"
        ? new Date(post.created_utc * 1000).toISOString()
        : null,
    raw: post,
    contact,
  };
}

/**
 * Adaptador de Reddit.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const redditAdapter: SourceAdapter = {
  slug: "reddit",
  displayName: "Reddit",
  configSchema,

  async fetchItems(rawConfig: unknown, cursor: SourceCursor): Promise<FetchResult> {
    const config: RedditConfig = configSchema.parse(rawConfig);
    const floor = readCursorFloor(cursor);

    const items: RawItem[] = [];
    let maxCreatedUtc = floor;
    let failures = 0;

    for (let i = 0; i < config.subreddits.length; i++) {
      const subreddit = config.subreddits[i];

      if (i > 0) await sleep(PAUSE_BETWEEN_SUBREDDITS_MS);

      let posts: RedditPostData[];
      try {
        posts = await fetchSubreddit(subreddit);
      } catch (err) {
        failures++;
        log.warn("Falló un subreddit, se continúa con el resto", {
          subreddit,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let kept = 0;
      for (const post of posts) {
        const createdUtc = post.created_utc;
        if (typeof createdUtc !== "number" || createdUtc <= floor) continue;
        if (config.hiringFlairOnly && !hasHiringFlair(post)) continue;

        items.push(toRawItem(post));
        maxCreatedUtc = Math.max(maxCreatedUtc, createdUtc);
        kept++;
      }

      log.info("Subreddit procesado", {
        subreddit,
        posts: posts.length,
        kept,
      });
    }

    // Si fallaron todos los subreddits, no hay nada que reportar: es un fallo
    // real de la fuente, no una corrida vacía legítima.
    if (failures > 0 && failures === config.subreddits.length) {
      throw new Error(
        `reddit: fallaron los ${failures} subreddit(s) configurados.`,
      );
    }

    log.info("Corrida de polling completa", {
      items: items.length,
      lastCreatedUtc: maxCreatedUtc,
    });

    return { items, cursor: { lastCreatedUtc: maxCreatedUtc } };
  },
};

registerSource(redditAdapter);

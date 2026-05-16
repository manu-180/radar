/**
 * Adaptador de fuente: feeds RSS genérico.
 *
 * A diferencia del resto de adaptadores, este **no** habla con una plataforma
 * concreta: lee cualquier cantidad de feeds RSS/Atom listados en su `config`.
 * Sumar una fuente nueva (otra ciudad de Craigslist, otra bolsa remota, un feed
 * cualquiera) es agregar una entrada `{ name, url }` al `config` — cero código.
 * Por eso un único `slug = 'rss'` cubre N plataformas.
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords
 * ni clasifica con IA. El polling es incremental — el cursor guarda, por feed,
 * la fecha del item más nuevo ya visto, así no se re-trae lo mismo.
 *
 * ## Degradación elegante
 *
 * Cada feed se baja y parsea de forma aislada: si uno falla (URL caída, XML
 * roto, IP bloqueada) se loguea y se sigue con los demás. Solo se lanza error
 * si fallan **todos** los feeds configurados — eso ya es un fallo real de la
 * fuente, no una corrida vacía legítima.
 */

import Parser from "rss-parser";
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

/** `User-Agent` propio para identificar al cliente ante cada feed. */
const USER_AGENT = "LeadDetector/1.0 (+rss-source-adapter)";

/**
 * Ventana de arranque cuando un feed no tiene cursor: ~26 h hacia atrás.
 *
 * Es algo más que el intervalo de polling típico para tolerar corridas
 * salteadas sin perder items.
 */
const LOOKBACK_MS = 26 * 60 * 60 * 1000;

/** Pausa entre feeds para no golpear servidores ni gatillar rate limits. */
const PAUSE_BETWEEN_FEEDS_MS = 500;

/** Config propia de la fuente RSS (columna `sources.config`). */
const configSchema = z.object({
  /** Feeds a monitorear. Cada uno es una "fuente" lógica con su nombre. */
  feeds: z
    .array(
      z.object({
        /** Nombre legible del feed; viaja en `author` de cada `RawItem`. */
        name: z.string().min(1),
        /** URL del feed RSS/Atom. */
        url: z.string().url(),
      }),
    )
    .default([]),
});

type RssConfig = z.infer<typeof configSchema>;
type FeedConfig = RssConfig["feeds"][number];

/** Item de feed con los campos que produce `rss-parser`. */
type FeedItem = Parser.Item;

const log = createLogger({ source: "rss" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parser reutilizable: solo se le pasa XML ya bajado, nunca una URL. */
const parser = new Parser({ headers: { "User-Agent": USER_AGENT } });

/**
 * Fecha de publicación de un item, como `Date`, o `null` si no hay ninguna
 * parseable. `rss-parser` ya normaliza `pubDate` a `isoDate` cuando puede.
 */
function itemDate(item: FeedItem): Date | null {
  const raw = item.isoDate ?? item.pubDate;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Piso temporal de un feed: la fecha guardada en el cursor o, si no hay (o no
 * parsea), `LOOKBACK_MS` hacia atrás desde ahora.
 */
function readFeedFloor(cursor: SourceCursor, feedName: string): Date {
  const stored = cursor[feedName];
  if (typeof stored === "string") {
    const ms = Date.parse(stored);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date(Date.now() - LOOKBACK_MS);
}

/** Mapea un item de feed a la forma neutral {@link RawItem}. */
function toRawItem(item: FeedItem, feed: FeedConfig): RawItem {
  // El `name` del feed prefija el id de la fuente para que sea único entre
  // feeds (dos feeds podrían reusar el mismo guid).
  const localId = item.guid ?? item.link ?? null;
  const date = itemDate(item);

  return {
    externalId: localId ? `${feed.name}:${localId}` : null,
    title: (item.title ?? "").trim(),
    body: (item.contentSnippet ?? item.content ?? "").trim(),
    url: (item.link ?? "").trim(),
    // El nombre del feed viaja en `author` para no perder de qué feed salió.
    author: feed.name,
    postedAt: date ? date.toISOString() : null,
    raw: item,
  };
}

/**
 * Baja y parsea un feed, devolviendo sus items posteriores a `floor`.
 *
 * Los items sin fecha parseable se conservan: el dedup por `externalId` del
 * pipeline evita re-emitirlos en corridas siguientes.
 */
async function fetchFeed(feed: FeedConfig, floor: Date): Promise<FeedItem[]> {
  const response = await fetchWithRetry(feed.url, { userAgent: USER_AGENT });
  const xml = await response.text();
  const parsed = await parser.parseString(xml);

  return parsed.items.filter((item) => {
    const date = itemDate(item);
    return date === null || date.getTime() > floor.getTime();
  });
}

/**
 * Adaptador de feeds RSS genérico.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const rssAdapter: SourceAdapter = {
  slug: "rss",
  displayName: "Feeds RSS",
  configSchema,

  async fetchItems(rawConfig: unknown, cursor: SourceCursor): Promise<FetchResult> {
    const config: RssConfig = configSchema.parse(rawConfig);

    const items: RawItem[] = [];
    const nextCursor: SourceCursor = {};
    let failures = 0;

    for (let i = 0; i < config.feeds.length; i++) {
      const feed = config.feeds[i];
      if (i > 0) await sleep(PAUSE_BETWEEN_FEEDS_MS);

      const floor = readFeedFloor(cursor, feed.name);

      let feedItems: FeedItem[];
      try {
        feedItems = await fetchFeed(feed, floor);
      } catch (err) {
        failures++;
        // El cursor del feed caído se conserva tal cual para no perder el
        // piso al recuperarse.
        if (typeof cursor[feed.name] === "string") {
          nextCursor[feed.name] = cursor[feed.name];
        }
        log.warn("Falló un feed, se continúa con el resto", {
          feed: feed.name,
          url: feed.url,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // El cursor avanza a la fecha del item más nuevo de esta corrida; si no
      // hubo items nuevos con fecha, se conserva el piso anterior.
      let maxMs = floor.getTime();
      let kept = 0;
      for (const item of feedItems) {
        const raw = toRawItem(item, feed);
        if (raw.title.length === 0) continue;
        items.push(raw);
        kept++;
        const date = itemDate(item);
        if (date) maxMs = Math.max(maxMs, date.getTime());
      }
      nextCursor[feed.name] = new Date(maxMs).toISOString();

      log.info("Feed procesado", {
        feed: feed.name,
        fetched: feedItems.length,
        kept,
      });
    }

    // Si fallaron todos los feeds es un fallo real de la fuente, no una
    // corrida vacía legítima.
    if (config.feeds.length > 0 && failures === config.feeds.length) {
      throw new Error(`rss: fallaron los ${failures} feed(s) configurados.`);
    }

    log.info("Corrida de polling completa", {
      items: items.length,
      feeds: config.feeds.length,
      failures,
    });

    return { items, cursor: nextCursor };
  },
};

registerSource(rssAdapter);

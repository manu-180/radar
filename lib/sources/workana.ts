/**
 * Adaptador de fuente: Workana.
 *
 * Workana es la bolsa freelance más relevante para el mercado argentino/LatAm:
 * cada proyecto listado es alguien que **explícitamente quiere contratar**. Este
 * adaptador baja las páginas de búsqueda de proyectos configuradas, parsea los
 * listados y los normaliza a {@link RawItem}.
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords ni
 * clasifica con IA.
 *
 * ## La fuente más frágil del sistema
 *
 * Workana **no tiene API pública** y está detrás de Cloudflare con anti-bot
 * moderno: no se la puede bajar con un `fetch` directo. Este adaptador usa el
 * **camino A** del paso 34 — un **servicio de scraping pago** (ScraperAPI):
 * cada URL de búsqueda se pide a través de ese servicio (`SCRAPER_API_KEY`), que
 * resuelve Cloudflare y el render de JS y devuelve el HTML ya listo. El servicio
 * cuesta ~US$30–50/mes y el parseo del HTML se rompe con cada cambio de markup
 * de Workana — es, a propósito, la única fuente con costo y fragilidad reales.
 * Por eso arranca **deshabilitada** (`sources.enabled = false`): se activa a mano
 * desde el panel cuando el scraping esté funcionando y el dueño acepte el costo.
 *
 * ## Degradación elegante y aislamiento
 *
 * Sin `SCRAPER_API_KEY`, `fetchItems` devuelve `{ items: [], cursor }` sin lanzar
 * error: la fuente queda inerte y el resto del sistema sigue intacto.
 *
 * Cada URL de búsqueda se baja y parsea de forma aislada: si una falla (timeout
 * del scraper, Cloudflare sin resolver, markup cambiado) se loguea y se sigue con
 * las demás. Solo se lanza error si fallan **todas** — eso ya es un fallo real de
 * la fuente. Como Workana es la más propensa a romperse, el aislamiento es
 * estricto: un fallo suyo nunca debe tumbar el poll de las otras fuentes (cada
 * `/api/poll/<slug>` corre aislado, así que un throw acá solo marca el `run` de
 * `workana` como `error`).
 *
 * El polling es incremental: el cursor guarda los IDs de proyecto ya vistos
 * (`lastSeenIds`) y cada corrida emite solo los proyectos cuyo ID no aparece ahí.
 */

import { z } from "zod";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { registerSource } from "@/lib/sources/registry";
import type {
  FetchResult,
  RawItem,
  SourceAdapter,
  SourceCursor,
} from "@/lib/sources/types";

/** `User-Agent` propio para identificar al cliente ante el servicio de scraping. */
const USER_AGENT = "LeadDetector/1.0 (+workana-source-adapter)";

/**
 * Endpoint del servicio de scraping (camino A, ScraperAPI).
 *
 * Se le pasa la URL objetivo como parámetro y devuelve el HTML ya resuelto
 * (Cloudflare + render de JS incluidos). Ver el encabezado del módulo.
 */
const SCRAPER_API_ENDPOINT = "https://api.scraperapi.com/";

/**
 * Timeout por intento al servicio de scraping, en ms.
 *
 * Resolver Cloudflare y renderizar JS es lento: el default de 15 s de
 * `fetchWithRetry` se queda corto. Se le da un margen amplio.
 */
const SCRAPER_TIMEOUT_MS = 70_000;

/**
 * Reintentos al servicio de scraping.
 *
 * Cada intento consume crédito pago y puede tardar ~1 min, así que se reintenta
 * menos que el default (3) de `fetchWithRetry`.
 */
const SCRAPER_RETRIES = 1;

/** Pausa entre URLs de búsqueda para espaciar el consumo del scraper. */
const PAUSE_BETWEEN_URLS_MS = 1_000;

/**
 * Tope de IDs que guarda el cursor.
 *
 * El cursor acumula los IDs de proyecto ya vistos para no re-emitirlos. Se
 * recorta a los más recientes para que no crezca sin límite.
 */
const MAX_SEEN_IDS = 800;

/** Largo máximo del cuerpo normalizado de un proyecto. */
const BODY_MAX_LENGTH = 2_000;

/** Config propia de la fuente Workana (columna `sources.config`). */
const configSchema = z.object({
  /**
   * URLs de páginas de búsqueda de proyectos de Workana a monitorear.
   *
   * Ej. una búsqueda filtrada por categoría de programación/web. Cada URL se
   * baja a través del servicio de scraping y se parsean sus listados.
   */
  searchUrls: z.array(z.string().url()).default([]),
});

type WorkanaConfig = z.infer<typeof configSchema>;

const log = createLogger({ source: "workana" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Proyecto de Workana ya extraído del HTML, antes de normalizar a `RawItem`. */
interface WorkanaProject {
  /** ID estable derivado del slug del proyecto en su URL. */
  id: string;
  /** Título del proyecto. */
  title: string;
  /** Descripción / cuerpo del proyecto. */
  body: string;
  /** URL pública absoluta del proyecto. */
  url: string;
}

/** IDs de proyecto ya vistos, leídos del cursor. */
function readSeenIds(cursor: SourceCursor): string[] {
  const stored = cursor.lastSeenIds;
  if (!Array.isArray(stored)) return [];
  return stored.filter((id): id is string => typeof id === "string");
}

/**
 * Arma la URL al servicio de scraping para bajar `target`.
 *
 * `render=true` resuelve el JS de la página; `country_code=ar` geolocaliza la
 * salida en Argentina, el mercado objetivo de Workana. El servicio resuelve el
 * desafío de Cloudflare por su cuenta.
 */
function buildScraperUrl(target: string, apiKey: string): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    url: target,
    render: "true",
    country_code: "ar",
  });
  return `${SCRAPER_API_ENDPOINT}?${params.toString()}`;
}

/** Decodifica las entidades HTML más comunes a su carácter. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–");
}

/** Quita las etiquetas HTML de un fragmento y normaliza los espacios. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrae los proyectos del HTML de una página de listados de Workana.
 *
 * ⚠️ **Esta es la parte frágil del adaptador.** Workana no tiene API: el único
 * camino es parsear su markup, y ese markup cambia sin aviso. Los selectores de
 * abajo apuntan a la estructura conocida de las páginas de búsqueda (tarjetas
 * `project-item` con un link al proyecto en `/job/<slug>`). Si Workana rediseña
 * los listados, esta función es lo primero que hay que ajustar — el resto del
 * adaptador no depende del markup.
 *
 * El parseo es deliberadamente tolerante: una tarjeta que no matchee se saltea
 * en silencio en vez de tumbar toda la corrida.
 */
function parseProjects(html: string, baseUrl: string): WorkanaProject[] {
  const projects: WorkanaProject[] = [];
  const seenIds = new Set<string>();

  // Cada proyecto es una "tarjeta" con la clase `project-item`. Se ubican los
  // arranques de tarjeta y se corta el HTML de cada una hasta el arranque de la
  // siguiente: aunque la tarjeta tenga divs anidados, ese trozo la contiene
  // entera y alcanza para extraer título, descripción y link.
  const cardMarker = /class="[^"]*\bproject-item\b[^"]*"/gi;
  const starts: number[] = [];
  let marker: RegExpExecArray | null;
  while ((marker = cardMarker.exec(html)) !== null) {
    starts.push(marker.index);
  }

  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i], starts[i + 1] ?? html.length);

    // Link al proyecto: el primer `<a href>` que apunta a `/job/<slug>`. El
    // slug es el ID estable de Workana.
    const linkMatch = chunk.match(
      /<a\b[^>]*\bhref="([^"]*\/job\/[^"#?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!linkMatch) continue;

    const href = decodeEntities(linkMatch[1]);
    const slugMatch = href.match(/\/job\/([^/#?]+)/i);
    if (!slugMatch) continue;
    const id = slugMatch[1];
    if (seenIds.has(id)) continue;

    const url = new URL(href, baseUrl).toString();
    const title = stripTags(linkMatch[2]);
    if (!title) continue;

    // Descripción: el primer bloque con la clase de detalle del proyecto. Si no
    // aparece, se cae al texto plano de toda la tarjeta como cuerpo de respaldo.
    const descMatch = chunk.match(
      /<(?:div|p)\b[^>]*\b(?:project-details|html-desc)\b[^>]*>([\s\S]*?)<\/(?:div|p)>/i,
    );
    const body = (
      descMatch ? stripTags(descMatch[1]) : stripTags(chunk)
    ).slice(0, BODY_MAX_LENGTH);

    seenIds.add(id);
    projects.push({ id, title, body, url });
  }

  return projects;
}

/**
 * Baja una URL de búsqueda de Workana a través del servicio de scraping y
 * devuelve los proyectos parseados.
 */
async function fetchSearchUrl(
  searchUrl: string,
  apiKey: string,
): Promise<WorkanaProject[]> {
  const response = await fetchWithRetry(buildScraperUrl(searchUrl, apiKey), {
    userAgent: USER_AGENT,
    timeoutMs: SCRAPER_TIMEOUT_MS,
    retries: SCRAPER_RETRIES,
  });
  const html = await response.text();
  return parseProjects(html, searchUrl);
}

/** Mapea un proyecto de Workana a la forma neutral {@link RawItem}. */
function toRawItem(project: WorkanaProject): RawItem {
  return {
    // El prefijo `workana:` mantiene el id único entre fuentes.
    externalId: `workana:${project.id}`,
    title: project.title,
    body: project.body,
    url: project.url,
    // Los listados de Workana solo muestran fechas relativas ("hace 2 horas"),
    // poco fiables de parsear: se deja `null` y el dedup por `externalId` /
    // `content_hash` del pipeline evita re-emitir el proyecto.
    author: null,
    postedAt: null,
    raw: project,
  };
}

/**
 * Adaptador de Workana.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const workanaAdapter: SourceAdapter = {
  slug: "workana",
  displayName: "Workana",
  configSchema,

  async fetchItems(
    rawConfig: unknown,
    cursor: SourceCursor,
  ): Promise<FetchResult> {
    const config: WorkanaConfig = configSchema.parse(rawConfig);

    // Degradación elegante: sin la API key del scraper la fuente queda inerte
    // (ver el encabezado del módulo). El cursor se devuelve tal cual.
    const apiKey = env.SCRAPER_API_KEY;
    if (!apiKey) {
      log.info("SCRAPER_API_KEY no está seteado; la fuente queda inerte");
      return { items: [], cursor };
    }

    if (config.searchUrls.length === 0) {
      log.info("Sin searchUrls configuradas; corrida vacía");
      return { items: [], cursor };
    }

    const seenIds = readSeenIds(cursor);
    const seenSet = new Set(seenIds);

    // Dedup por id: un proyecto puede aparecer en varias URLs de búsqueda.
    const fresh = new Map<string, WorkanaProject>();
    let failures = 0;

    for (let i = 0; i < config.searchUrls.length; i++) {
      const searchUrl = config.searchUrls[i];
      if (i > 0) await sleep(PAUSE_BETWEEN_URLS_MS);

      let projects: WorkanaProject[];
      try {
        projects = await fetchSearchUrl(searchUrl, apiKey);
      } catch (err) {
        failures++;
        log.warn("Falló una URL de búsqueda, se continúa con el resto", {
          searchUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let kept = 0;
      for (const project of projects) {
        if (seenSet.has(project.id) || fresh.has(project.id)) continue;
        fresh.set(project.id, project);
        kept++;
      }

      log.info("URL de búsqueda procesada", {
        searchUrl,
        projects: projects.length,
        kept,
      });
    }

    // Si fallaron todas las URLs es un fallo real de la fuente, no una corrida
    // vacía legítima. El throw solo marca el `run` de `workana` como `error`:
    // los demás polls corren aislados y no se ven afectados.
    if (failures === config.searchUrls.length) {
      throw new Error(
        `workana: fallaron las ${failures} URL(s) de búsqueda configuradas.`,
      );
    }

    const items = [...fresh.values()].map(toRawItem);

    // El cursor acumula los IDs nuevos delante de los viejos y se recorta a los
    // más recientes, así no crece sin límite.
    const nextSeenIds = [...fresh.keys(), ...seenIds].slice(0, MAX_SEEN_IDS);

    log.info("Corrida de polling completa", {
      items: items.length,
      searchUrls: config.searchUrls.length,
      failures,
    });

    return { items, cursor: { lastSeenIds: nextSeenIds } };
  },
};

registerSource(workanaAdapter);

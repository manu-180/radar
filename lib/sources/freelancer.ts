/**
 * Adaptador de fuente: Freelancer.com.
 *
 * Freelancer.com es una bolsa de proyectos: cada resultado es un proyecto
 * publicado por alguien que **explícitamente quiere contratar**. Este adaptador
 * consulta la API oficial de proyectos activos (gratis) por cada query
 * configurada, se queda con los proyectos nuevos y los normaliza a
 * {@link RawItem}.
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords
 * ni clasifica con IA. El polling es incremental — el cursor guarda el mayor
 * `submitdate` visto para no re-traer lo mismo en cada corrida.
 *
 * ## Degradación elegante
 *
 * La API exige el header `freelancer-oauth-v1` con un token personal de la
 * cuenta del dueño (`env.FREELANCER_OAUTH_TOKEN`, opcional). Si el token no
 * está seteado, `fetchItems` devuelve `{ items: [], cursor }` sin lanzar error:
 * la fuente queda inerte hasta configurarse y el resto del sistema sigue
 * intacto. Obtener el token es un trámite menor, no un bloqueante.
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

/** Endpoint de la API oficial de proyectos activos de Freelancer.com. */
const PROJECTS_ACTIVE_URL =
  "https://www.freelancer.com/api/projects/0.1/projects/active/";

/** `User-Agent` propio para identificar al cliente ante la API. */
const USER_AGENT = "LeadDetector/1.0 (+freelancer-source-adapter)";

/** Cantidad de proyectos a pedir por query. */
const PROJECTS_PER_QUERY = 50;

/**
 * Ventana de arranque cuando el cursor está vacío: ~26 h hacia atrás.
 *
 * Es algo más que el intervalo de polling típico para tolerar corridas
 * salteadas sin perder proyectos.
 */
const LOOKBACK_SECONDS = 26 * 60 * 60;

/** Pausa entre queries para no golpear la API de Freelancer.com. */
const PAUSE_BETWEEN_QUERIES_MS = 1_000;

/** Config propia de la fuente Freelancer.com (columna `sources.config`). */
const configSchema = z.object({
  /** Términos a buscar entre los proyectos activos de Freelancer.com. */
  queries: z.array(z.string()),
});

type FreelancerConfig = z.infer<typeof configSchema>;

/** Forma parcial de un proyecto de la API, con sólo los campos que usamos. */
interface FreelancerProject {
  id?: number | null;
  owner_id?: number | null;
  title?: string | null;
  description?: string | null;
  preview_description?: string | null;
  seo_url?: string | null;
  submitdate?: number | null;
}

/** Respuesta del endpoint `projects/active`. */
interface FreelancerResponse {
  status?: string | null;
  result?: {
    projects?: FreelancerProject[] | null;
  } | null;
}

const log = createLogger({ source: "freelancer" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cursor de esta fuente: el mayor `submitdate` (unix seg) ya procesado. */
function readCursorFloor(cursor: SourceCursor): number {
  const last = cursor.lastSubmitDate;
  if (typeof last === "number" && Number.isFinite(last)) return last;
  return Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS;
}

/**
 * Trae los proyectos activos que mencionan `query`.
 *
 * Pide la descripción completa (`full_description`) y los datos del rubro
 * (`job_details`) para que cada proyecto tenga título y cuerpo. La auth va en
 * el header `freelancer-oauth-v1`, como exige la API.
 */
async function fetchActiveProjects(
  query: string,
  token: string,
): Promise<FreelancerProject[]> {
  const params = new URLSearchParams({
    query,
    full_description: "true",
    job_details: "true",
    limit: String(PROJECTS_PER_QUERY),
  });
  const response = await fetchWithRetry(`${PROJECTS_ACTIVE_URL}?${params}`, {
    userAgent: USER_AGENT,
    headers: { "freelancer-oauth-v1": token },
  });
  const data = (await response.json()) as FreelancerResponse;

  // La API devuelve 200 con un `status` propio: un valor distinto de "success"
  // es un fallo lógico que `fetchWithRetry` no detecta.
  if (data.status && data.status !== "success") {
    throw new Error(`la API respondió status "${data.status}"`);
  }

  const projects = data.result?.projects;
  return Array.isArray(projects) ? projects : [];
}

/** Mapea un proyecto de Freelancer.com a la forma neutral {@link RawItem}. */
function toRawItem(project: FreelancerProject): RawItem {
  const body = (project.description ?? project.preview_description ?? "").trim();
  const url = project.seo_url
    ? `https://www.freelancer.com/projects/${project.seo_url}`
    : `https://www.freelancer.com/projects/${project.id}`;

  return {
    externalId: project.id != null ? String(project.id) : null,
    title: (project.title ?? "").trim(),
    body,
    url,
    author:
      typeof project.owner_id === "number" ? String(project.owner_id) : null,
    postedAt:
      typeof project.submitdate === "number"
        ? new Date(project.submitdate * 1000).toISOString()
        : null,
    raw: project,
  };
}

/**
 * Adaptador de Freelancer.com.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const freelancerAdapter: SourceAdapter = {
  slug: "freelancer",
  displayName: "Freelancer.com",
  // Cada proyecto activo es, por definición, alguien que quiere contratar: no
  // pasa por el filtro de keywords (lo juzga el clasificador). Ver types.ts.
  skipPrefilter: true,
  configSchema,

  async fetchItems(rawConfig: unknown, cursor: SourceCursor): Promise<FetchResult> {
    const config: FreelancerConfig = configSchema.parse(rawConfig);

    // Degradación elegante: sin token la fuente queda inerte (ver encabezado).
    const token = env.FREELANCER_OAUTH_TOKEN;
    if (!token) {
      log.info("FREELANCER_OAUTH_TOKEN no seteado; la fuente queda inerte");
      return { items: [], cursor };
    }

    const floor = readCursorFloor(cursor);

    // Dedup por id: un proyecto puede matchear varias queries.
    const seen = new Map<number, FreelancerProject>();
    let maxSubmitDate = floor;
    let failures = 0;

    for (let i = 0; i < config.queries.length; i++) {
      const query = config.queries[i];
      if (i > 0) await sleep(PAUSE_BETWEEN_QUERIES_MS);

      let projects: FreelancerProject[];
      try {
        projects = await fetchActiveProjects(query, token);
      } catch (err) {
        failures++;
        log.warn("Falló una query, se continúa con el resto", {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      let kept = 0;
      for (const project of projects) {
        const { id, submitdate } = project;
        if (typeof id !== "number" || seen.has(id)) continue;
        if (typeof submitdate !== "number" || submitdate <= floor) continue;

        seen.set(id, project);
        maxSubmitDate = Math.max(maxSubmitDate, submitdate);
        kept++;
      }

      log.info("Query procesada", { query, projects: projects.length, kept });
    }

    // Si fallaron todas las queries es un fallo real de la fuente, no una
    // corrida vacía legítima.
    if (failures > 0 && failures === config.queries.length) {
      throw new Error(
        `freelancer: fallaron las ${failures} query(s) configuradas.`,
      );
    }

    const items = [...seen.values()]
      .map(toRawItem)
      .filter((item) => item.title.length > 0);

    log.info("Corrida de polling completa", {
      items: items.length,
      lastSubmitDate: maxSubmitDate,
    });

    return { items, cursor: { lastSubmitDate: maxSubmitDate } };
  },
};

registerSource(freelancerAdapter);

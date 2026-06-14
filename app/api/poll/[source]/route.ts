/**
 * Ruta de polling por fuente.
 *
 * `POST /api/poll/<slug>` corre una corrida de polling completa para una sola
 * fuente: pide items nuevos al adaptador, los pre-filtra y los persiste. Cada
 * fuente se sondea en su propia invocación —con su propio presupuesto de 300 s
 * y su propio aislamiento de fallas— para que una fuente caída no arrastre al
 * resto.
 *
 * La ruta es genérica: funciona con cualquier adaptador registrado en el
 * registry. Sumar una fuente nueva no toca este archivo.
 *
 * La dispara `/api/cron/dispatch`; está protegida por el header `x-cron-secret`.
 */

import { contentHash, detectLang } from "@/lib/filter/normalize";
import { loadKeywords, decidePrefilter } from "@/lib/filter/prefilter";
import { finishRun, startRun } from "@/lib/db/runs";
import { persistLeads, type LeadRow } from "@/lib/db/leads";
import { createLogger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { getSource, type SourceCursor } from "@/lib/sources";
import { getAdminClient } from "@/lib/supabase/admin";

/** Cada corrida de polling se ejecuta sin caché. */
export const dynamic = "force-dynamic";
/** Una fuente lenta puede tardar: hasta 5 min por invocación. */
export const maxDuration = 300;

const log = createLogger({ route: "poll" });

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ source: string }> },
): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const { source: slug } = await params;
  const db = getAdminClient();

  // Fila de la fuente: tiene que existir y estar habilitada.
  const { data: sourceRow, error: sourceErr } = await db
    .from("sources")
    .select("slug, enabled, config, cursor")
    .eq("slug", slug)
    .maybeSingle();

  if (sourceErr) {
    log.error("No se pudo leer la fuente", { source: slug, error: sourceErr.message });
    return json({ error: `No se pudo leer la fuente: ${sourceErr.message}` }, 500);
  }
  if (!sourceRow) {
    return json({ error: `Fuente desconocida: "${slug}"` }, 404);
  }
  if (!sourceRow.enabled) {
    return json({ error: `Fuente deshabilitada: "${slug}"` }, 409);
  }

  const runId = await startRun("poll", slug);
  const runLog = log.child({ runId, source: slug });
  runLog.info("Corrida de polling iniciada");

  try {
    const adapter = getSource(slug);
    if (!adapter) {
      // La fuente está en la base pero no tiene adaptador en el código: es una
      // inconsistencia de configuración del servidor, no un error del llamador.
      const msg = `Sin adaptador registrado para la fuente "${slug}"`;
      runLog.error(msg);
      await finishRun(runId, { status: "error", error: msg });
      return json({ error: msg, source: slug, runId }, 500);
    }

    // El `config` guardado en la base debe satisfacer el schema del adaptador.
    const parsedConfig = adapter.configSchema.safeParse(sourceRow.config);
    if (!parsedConfig.success) {
      const msg = `config inválido para "${slug}": ${parsedConfig.error.message}`;
      runLog.error("config de la fuente inválido", { error: parsedConfig.error.message });
      await finishRun(runId, { status: "error", error: msg });
      return json({ error: msg, source: slug, runId }, 422);
    }

    // Polling incremental: el cursor entra y sale del adaptador.
    const cursorIn = (sourceRow.cursor ?? {}) as SourceCursor;
    const { items, cursor: cursorOut } = await adapter.fetchItems(
      parsedConfig.data,
      cursorIn,
    );
    runLog.info("Items traídos del adaptador", { items: items.length });

    // Pre-filtro determinístico por keywords (sin red, sin IA). Los items que
    // no pasan se guardan igual, pero marcados `skipped` en ambas colas.
    const keywords = await loadKeywords();
    const rows: LeadRow[] = items.map((item) => {
      const lang = detectLang(`${item.title} ${item.body}`);
      const result = decidePrefilter(item, lang, keywords, adapter.skipPrefilter ?? false);
      const queueStatus = result.passed ? "pending" : "skipped";
      // Datos de contacto para el outreach de v2: sólo los traen las fuentes
      // cuyo autor es contactable. Se setean siempre (a `null` si no hay) para
      // que todas las filas del lote tengan las mismas columnas en el upsert.
      const contact = item.contact ?? null;
      return {
        source: slug,
        external_id: item.externalId,
        content_hash: contentHash(item),
        title: item.title,
        body: item.body,
        url: item.url,
        author: item.author,
        lang,
        posted_at: item.postedAt,
        raw: item.raw,
        prefilter_matched: result.matched,
        llm_status: queueStatus,
        notify_status: queueStatus,
        contact_channel: contact?.channel ?? null,
        contact_key: contact?.key ?? null,
        contact_ref: contact?.ref ?? null,
        contact_handle: contact?.handle ?? null,
      };
    });

    const persisted = await persistLeads(rows);
    const prefilterPassed = rows.filter((r) => r.llm_status === "pending").length;
    runLog.info("Leads persistidos", {
      found: persisted.found,
      new: persisted.new,
      prefilterPassed,
    });

    // El cursor solo avanza si el poll llegó hasta acá sin fallar: si algo
    // explota antes, el próximo tick reintenta desde donde quedó.
    const { error: cursorErr } = await db
      .from("sources")
      .update({ cursor: cursorOut, last_polled_at: new Date().toISOString() })
      .eq("slug", slug);
    if (cursorErr) {
      throw new Error(`No se pudo persistir el cursor: ${cursorErr.message}`);
    }

    await finishRun(runId, {
      status: "ok",
      itemsFound: persisted.found,
      itemsNew: persisted.new,
    });
    runLog.info("Corrida de polling completa");

    return json(
      { ok: true, source: slug, runId, found: persisted.found, new: persisted.new },
      200,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runLog.error("Corrida de polling falló", { error: message });
    try {
      await finishRun(runId, { status: "error", error: message });
    } catch (finishErr) {
      // Cerrar la corrida también falló: lo dejamos en el log, pero la
      // respuesta sigue siendo el error original del poll.
      runLog.error("Además, no se pudo cerrar la corrida", {
        error: finishErr instanceof Error ? finishErr.message : String(finishErr),
      });
    }
    return json({ error: message, source: slug, runId }, 500);
  }
}

/**
 * Ruta de primer contacto (engage) del Autopilot.
 *
 * `POST /api/engage` drena la cola de primer contacto: reclama un lote de leads
 * clasificados, contactables y que califican, y abre una conversación con cada
 * uno mandando el mensaje de apertura (modo opener del agente). Es el arranque
 * del closer automático de v2.
 *
 * Diseño (espejo de `/api/notify`):
 *  - **Interruptor maestro**: si `outreach_enabled` está en `false`, no se
 *    contacta a nadie y la corrida termina sin reclamar nada.
 *  - **Tope diario anti-ban** (`outreach_daily_cap`): se cuentan las
 *    conversaciones creadas hoy y sólo se abren las que falten para el tope; si
 *    ya se llegó, la corrida no engancha a nadie.
 *  - **Reclamo sin condiciones de carrera**: el lote se toma con
 *    `claim_leads_to_engage` (FOR UPDATE SKIP LOCKED). Dos corridas solapadas
 *    nunca enganchan el mismo lead.
 *  - **Ritmo humano**: se espera 3–6 s entre primeros contactos para no disparar
 *    una ráfaga sospechosa.
 *  - **Fallos aislados**: `openConversationForLead` maneja sus propios errores y
 *    no lanza ante un fallo normal, pero igual se envuelve en try/catch para que
 *    un lead roto no aborte el lote.
 *
 * La dispara el cron; está protegida por el header `x-cron-secret`.
 */

import { openConversationForLead } from "@/lib/conversation/engine";
import { claimLeadsToEngage } from "@/lib/db/conversations";
import { finishRun, startRun } from "@/lib/db/runs";
import { createLogger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { loadAutopilotSettings } from "@/lib/settings";
import { getAdminClient } from "@/lib/supabase/admin";
import type { Lead } from "@/types/autopilot";

/** Cada corrida de engage se ejecuta sin caché. */
export const dynamic = "force-dynamic";
/** Enganchar un lote, con esperas entre contactos, puede tardar: hasta 5 min. */
export const maxDuration = 300;

/** Tamaño máximo del lote que se reclama de la cola en cada corrida. */
const BATCH_SIZE = 10;
/** Espera mínima y máxima (ms) entre dos primeros contactos consecutivos. */
const SEND_DELAY_MIN_MS = 3_000;
const SEND_DELAY_MAX_MS = 6_000;

const log = createLogger({ route: "engage" });

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Devuelve una espera aleatoria dentro del rango {@link SEND_DELAY_MIN_MS}–{@link SEND_DELAY_MAX_MS}. */
function randomSendDelay(): number {
  return (
    SEND_DELAY_MIN_MS +
    Math.random() * (SEND_DELAY_MAX_MS - SEND_DELAY_MIN_MS)
  );
}

/** ISO del comienzo del día de hoy (medianoche local), para el tope diario. */
function startOfTodayISO(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

/** Desenlace de enganchar un lead, para las métricas de la corrida. */
type EngageStatus = "engaged" | "failed";

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const db = getAdminClient();

  const runId = await startRun("engage");
  const runLog = log.child({ runId });
  runLog.info("Corrida de engage iniciada");

  let runStatus: "ok" | "error" = "ok";
  let runError: string | null = null;
  let claimed = 0;
  const tally: Record<EngageStatus, number> = { engaged: 0, failed: 0 };

  try {
    const s = await loadAutopilotSettings();

    // Interruptor maestro: sin outreach habilitado, no se contacta a nadie.
    if (!s.outreachEnabled) {
      runLog.info("Outreach deshabilitado; no se engancha a nadie");
      await finishRun(runId, { status: "ok", itemsFound: 0, itemsProcessed: 0 });
      return json({ ok: true, runId, skipped: "outreach deshabilitado" }, 200);
    }

    // Tope diario anti-ban: cuántos primeros contactos quedan para hoy.
    const { count: todayCount, error: countErr } = await db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .gte("created_at", startOfTodayISO());
    if (countErr) {
      throw new Error(`No se pudo contar las conversaciones de hoy: ${countErr.message}`);
    }
    const remaining = s.outreachDailyCap - (todayCount ?? 0);
    if (remaining <= 0) {
      runLog.info("Tope diario de primer contacto alcanzado; no se engancha a nadie", {
        todayCount: todayCount ?? 0,
        dailyCap: s.outreachDailyCap,
      });
      await finishRun(runId, { status: "ok", itemsFound: 0, itemsProcessed: 0 });
      return json(
        { ok: true, runId, skipped: "tope diario alcanzado" },
        200,
      );
    }

    // Reclamo atómico del lote (FOR UPDATE SKIP LOCKED dentro de la función).
    // Se acota al mínimo entre el tamaño de lote y lo que falte para el tope.
    const leads = (await claimLeadsToEngage(
      Math.min(BATCH_SIZE, remaining),
      s.engageRule.categories,
      s.engageRule.minScore,
    )) as Lead[];
    claimed = leads.length;
    runLog.info("Lote reclamado", {
      claimed,
      remaining,
      dailyCap: s.outreachDailyCap,
    });

    // Primer contacto secuencial con una espera de 3–6 s entre leads: enganchar
    // de a uno mantiene un ritmo humano y deja un orden predecible.
    for (let i = 0; i < leads.length; i++) {
      const leadLog = runLog.child({ leadId: leads[i].id });
      try {
        const result = await openConversationForLead(leads[i], s);
        if (result.ok) {
          tally.engaged += 1;
          leadLog.info("Lead enganchado", {
            reason: result.reason,
            conversationId: result.conversationId,
          });
        } else {
          tally.failed += 1;
          leadLog.warn("No se pudo enganchar el lead", { reason: result.reason });
        }
      } catch (err) {
        // `openConversationForLead` no debería lanzar ante un fallo normal; si
        // lo hace, se aísla para no abortar el resto del lote.
        tally.failed += 1;
        leadLog.error("Error inesperado al enganchar el lead", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (i < leads.length - 1) await sleep(randomSendDelay());
    }
  } catch (err) {
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    runLog.error("Corrida de engage falló", { error: runError });
  }

  // `itemsFound` = leads reclamados; `itemsProcessed` = primeros contactos
  // efectivamente enviados. El conteo de fallos viaja en el log y la respuesta.
  await finishRun(runId, {
    status: runStatus,
    itemsFound: claimed,
    itemsProcessed: tally.engaged,
    error: runError,
  });
  runLog.info("Corrida de engage terminada", {
    status: runStatus,
    claimed,
    engaged: tally.engaged,
    failed: tally.failed,
  });

  return json(
    {
      ok: runStatus === "ok",
      runId,
      claimed,
      engaged: tally.engaged,
      failed: tally.failed,
    },
    runStatus === "ok" ? 200 : 500,
  );
}

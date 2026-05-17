/**
 * Ruta de notificación de leads.
 *
 * `POST /api/notify` drena la cola de notificación: reclama un lote de leads
 * ya clasificados que ameritan un aviso, los manda por WhatsApp al dueño del
 * sistema y registra cada envío.
 *
 * Diseño:
 *  - **Un solo aviso por lead, sin condiciones de carrera**: el lote se reclama
 *    con la función `claim_leads_to_notify`, que usa `FOR UPDATE SKIP LOCKED` y
 *    mueve `notify_status` de `pending` a `sending` de forma atómica. Dos
 *    corridas solapadas de `/api/notify` nunca toman el mismo lead, y un lead
 *    ya `sent` nunca se reenvía.
 *  - **Tope por corrida** (`settings.max_notifications_per_run`): ante un pico
 *    —típicamente la primera corrida— se avisan N leads como máximo; el resto
 *    queda `pending` y sale en los ticks siguientes del cron.
 *  - **Ritmo humano**: se espera 3–5 s entre envíos para no disparar una
 *    ráfaga sospechosa contra WhatsApp.
 *  - **Fallos aislados**: si un envío falla, el lead queda `failed` y se
 *    registra el error en `notifications`; el resto del lote sigue.
 *
 * La dispara el cron; está protegida por el header `x-cron-secret`.
 */

import { buildLeadMessage } from "@/lib/notify/message";
import { sendWhatsApp } from "@/lib/notify/evolution";
import { finishRun, startRun } from "@/lib/db/runs";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { loadNotifySettings } from "@/lib/settings";
import { getAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/types/database";

/** Cada corrida de notificación se ejecuta sin caché. */
export const dynamic = "force-dynamic";
/** Avisar un lote completo, con esperas entre envíos, puede tardar: hasta 5 min. */
export const maxDuration = 300;

/** Espera mínima y máxima (ms) entre dos envíos consecutivos de WhatsApp. */
const SEND_DELAY_MIN_MS = 3_000;
const SEND_DELAY_MAX_MS = 5_000;

const log = createLogger({ route: "notify" });

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

/** Desenlace de avisar un lead, para las métricas de la corrida. */
type NotifyStatus = "sent" | "failed";

/**
 * Avisa un lead reclamado: arma el mensaje, lo manda por WhatsApp y persiste el
 * resultado en `notifications` y en el propio lead.
 *
 * Nunca lanza: cualquier error del envío se traduce a `notify_status='failed'`
 * y a una fila de `notifications` con el detalle, para no abortar el lote.
 */
async function notifyLead(
  lead: Tables<"leads">,
  db: ReturnType<typeof getAdminClient>,
  runLog: ReturnType<typeof createLogger>,
): Promise<NotifyStatus> {
  const leadLog = runLog.child({ leadId: lead.id });

  try {
    const message = buildLeadMessage(lead);
    const { id: providerMessageId } = await sendWhatsApp(
      env.OWNER_WHATSAPP,
      message,
    );

    // El lead avisó bien: se cierra su cola de notificación.
    const { error: leadErr } = await db
      .from("leads")
      .update({ notify_status: "sent", notified_at: new Date().toISOString() })
      .eq("id", lead.id);
    if (leadErr) {
      leadLog.error("No se pudo marcar el lead como notificado", {
        error: leadErr.message,
      });
    }

    const { error: notifErr } = await db.from("notifications").insert({
      lead_id: lead.id,
      channel: "whatsapp",
      provider_message_id: providerMessageId,
      status: "sent",
    });
    if (notifErr) {
      leadLog.error("No se pudo registrar la notificación enviada", {
        error: notifErr.message,
      });
    }

    leadLog.info("Lead notificado", { providerMessageId });
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    const { error: leadErr } = await db
      .from("leads")
      .update({ notify_status: "failed" })
      .eq("id", lead.id);
    if (leadErr) {
      leadLog.error("No se pudo marcar el lead como fallido", {
        error: leadErr.message,
      });
    }

    const { error: notifErr } = await db.from("notifications").insert({
      lead_id: lead.id,
      channel: "whatsapp",
      status: "failed",
      error: message,
    });
    if (notifErr) {
      leadLog.error("No se pudo registrar la notificación fallida", {
        error: notifErr.message,
      });
    }

    leadLog.error("Fallo al notificar el lead", { error: message });
    return "failed";
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const db = getAdminClient();

  const runId = await startRun("notify");
  const runLog = log.child({ runId });
  runLog.info("Corrida de notificación iniciada");

  let runStatus: "ok" | "error" = "ok";
  let runError: string | null = null;
  let claimed = 0;
  const tally: Record<NotifyStatus, number> = { sent: 0, failed: 0 };

  try {
    const settings = await loadNotifySettings();

    // Reclamo atómico del lote (FOR UPDATE SKIP LOCKED dentro de la función).
    // `maxNotificationsPerRun` acota cuántos avisos salen en esta corrida.
    const { data: leads, error: claimErr } = await db.rpc(
      "claim_leads_to_notify",
      {
        batch_size: settings.maxNotificationsPerRun,
        cats: settings.notifyRule.categories,
        min_score: settings.notifyRule.minScore,
      },
    );
    if (claimErr) {
      throw new Error(`No se pudo reclamar el lote: ${claimErr.message}`);
    }

    const batch = (leads ?? []) as Tables<"leads">[];
    claimed = batch.length;
    runLog.info("Lote reclamado", {
      claimed,
      maxPerRun: settings.maxNotificationsPerRun,
    });

    // Envío secuencial con una espera de 3–5 s entre leads: avisar de a uno
    // mantiene un ritmo humano y deja un orden de envío predecible.
    for (let i = 0; i < batch.length; i++) {
      const status = await notifyLead(batch[i], db, runLog);
      tally[status] += 1;
      if (i < batch.length - 1) await sleep(randomSendDelay());
    }
  } catch (err) {
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    runLog.error("Corrida de notificación falló", { error: runError });
  }

  // `itemsFound` = leads reclamados; `itemsProcessed` = avisos efectivamente
  // enviados. El conteo de fallos viaja en el log y en la respuesta.
  await finishRun(runId, {
    status: runStatus,
    itemsFound: claimed,
    itemsProcessed: tally.sent,
    error: runError,
  });
  runLog.info("Corrida de notificación terminada", {
    status: runStatus,
    claimed,
    sent: tally.sent,
    failed: tally.failed,
  });

  return json(
    {
      ok: runStatus === "ok",
      runId,
      claimed,
      sent: tally.sent,
      failed: tally.failed,
    },
    runStatus === "ok" ? 200 : 500,
  );
}

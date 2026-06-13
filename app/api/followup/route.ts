/**
 * Ruta de reenganche (follow-up) del Autopilot.
 *
 * `POST /api/followup` reengancha las conversaciones que se enfriaron: reclama
 * las que tienen un follow-up vencido (`next_action_at` en el pasado) y corre un
 * turno de reenganche del agente sobre cada una. Es lo que mantiene viva una
 * conversación cuando el lead deja de responder, sin pasarse de insistente.
 *
 * Diseño (espejo de `/api/notify`):
 *  - **Reclamo sin condiciones de carrera**: el lote se toma con
 *    `claim_conversations_due` (FOR UPDATE SKIP LOCKED + claim de turno). Dos
 *    corridas solapadas nunca reenganchan la misma conversación.
 *  - **Ritmo humano**: se espera 3–6 s entre reenganches para no disparar una
 *    ráfaga sospechosa.
 *  - **Fallos aislados**: `runConversationFollowup` maneja sus propios errores y
 *    libera el claim en `finally`, pero igual se envuelve en try/catch para que
 *    una conversación rota no aborte el lote.
 *  - **Tope de follow-ups**: la política (cuántos y cada cuánto) la aplica el
 *    motor; agotados los follow-ups, marca la conversación como perdida.
 *
 * La dispara el cron; está protegida por el header `x-cron-secret`.
 */

import { runConversationFollowup } from "@/lib/conversation/engine";
import { claimConversationsDue } from "@/lib/db/conversations";
import { finishRun, startRun } from "@/lib/db/runs";
import { createLogger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { loadAutopilotSettings } from "@/lib/settings";
import type { Conversation } from "@/types/autopilot";

/** Cada corrida de follow-up se ejecuta sin caché. */
export const dynamic = "force-dynamic";
/** Reenganchar un lote, con esperas entre turnos, puede tardar: hasta 5 min. */
export const maxDuration = 300;

/** Tamaño del lote de conversaciones vencidas que se reclama por corrida. */
const BATCH_SIZE = 10;
/** Espera mínima y máxima (ms) entre dos reenganches consecutivos. */
const SEND_DELAY_MIN_MS = 3_000;
const SEND_DELAY_MAX_MS = 6_000;

const log = createLogger({ route: "followup" });

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

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const runId = await startRun("followup");
  const runLog = log.child({ runId });
  runLog.info("Corrida de follow-up iniciada");

  let runStatus: "ok" | "error" = "ok";
  let runError: string | null = null;
  let due = 0;
  let processed = 0;

  try {
    const s = await loadAutopilotSettings();

    // Reclamo atómico del lote (FOR UPDATE SKIP LOCKED dentro de la función).
    const conversations = (await claimConversationsDue(BATCH_SIZE)) as Conversation[];
    due = conversations.length;
    runLog.info("Lote de conversaciones vencidas reclamado", { due });

    // Reenganche secuencial con una espera de 3–6 s entre conversaciones: de a
    // una mantiene un ritmo humano y deja un orden predecible.
    for (let i = 0; i < conversations.length; i++) {
      const convLog = runLog.child({ conversationId: conversations[i].id });
      try {
        await runConversationFollowup(conversations[i], s);
        processed += 1;
      } catch (err) {
        // `runConversationFollowup` libera el claim en su propio `finally`; este
        // catch sólo evita que una conversación rota aborte el resto del lote.
        convLog.error("Fallo al reenganchar la conversación", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (i < conversations.length - 1) await sleep(randomSendDelay());
    }
  } catch (err) {
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    runLog.error("Corrida de follow-up falló", { error: runError });
  }

  // `itemsFound` = conversaciones vencidas reclamadas; `itemsProcessed` = las
  // que pasaron por un turno de reenganche sin lanzar.
  await finishRun(runId, {
    status: runStatus,
    itemsFound: due,
    itemsProcessed: processed,
    error: runError,
  });
  runLog.info("Corrida de follow-up terminada", {
    status: runStatus,
    due,
    processed,
  });

  return json(
    { ok: runStatus === "ok", runId, due, processed },
    runStatus === "ok" ? 200 : 500,
  );
}

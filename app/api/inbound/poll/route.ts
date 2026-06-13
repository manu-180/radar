/**
 * Polling de entrantes para canales sin webhook.
 *
 * `POST /api/inbound/poll` sondea los canales que no pueden empujar entrantes
 * por webhook (Bluesky, Reddit) y traen sus mensajes nuevos por pull. Cada
 * entrante encontrado se pasa al motor de conversación, igual que los webhooks.
 *
 * Diseño:
 *  - **Sólo canales con `pollInbound`**: los canales con webhook (WhatsApp,
 *    Telegram) reciben por `/api/inbound/*` y se saltean acá.
 *  - **Aislamiento por canal**: si el sondeo de un canal falla, se loguea y se
 *    sigue con los demás — un canal caído no tira abajo la corrida.
 *  - **Idempotencia**: la deduplicación por `channel_message_id` vive en el
 *    motor, así un mensaje que aparece en dos sondeos no se responde dos veces.
 *
 * La dispara el cron; está protegida por el header `x-cron-secret`.
 */

import { ingestInbound } from "@/lib/conversation/engine";
import { listChannels } from "@/lib/channels";
import { finishRun, startRun } from "@/lib/db/runs";
import { createLogger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { loadAutopilotSettings } from "@/lib/settings";

/** Cada corrida de polling de entrantes se ejecuta sin caché. */
export const dynamic = "force-dynamic";
/** Sondear varios canales y procesar sus entrantes puede tardar: hasta 5 min. */
export const maxDuration = 300;

const log = createLogger({ route: "inbound/poll" });

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const runId = await startRun("inbound");
  const runLog = log.child({ runId });
  runLog.info("Corrida de polling de entrantes iniciada");

  let runStatus: "ok" | "error" = "ok";
  let runError: string | null = null;
  let found = 0;
  let processed = 0;

  try {
    const s = await loadAutopilotSettings();

    // Sólo los canales que reciben por pull (los de webhook no exponen pollInbound).
    const pollers = listChannels().filter((adapter) => adapter.pollInbound);
    runLog.info("Canales con polling de entrantes", {
      channels: pollers.map((a) => a.channel),
    });

    for (const adapter of pollers) {
      const channelLog = runLog.child({ channel: adapter.channel });
      try {
        const msgs = await adapter.pollInbound!();
        found += msgs.length;
        channelLog.info("Entrantes sondeados", { count: msgs.length });

        // Cada entrante se procesa de a uno; un fallo de uno no corta el canal.
        for (const m of msgs) {
          try {
            const r = await ingestInbound(m, s);
            if (r.handled) processed += 1;
          } catch (err) {
            channelLog.error("Fallo al procesar un entrante sondeado", {
              contactKey: m.contactKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        // Aislamiento por canal: un canal caído no tira abajo la corrida.
        channelLog.error("Fallo al sondear el canal", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    runLog.error("Corrida de polling de entrantes falló", { error: runError });
  }

  // `itemsFound` = entrantes sondeados; `itemsProcessed` = los que el motor tomó.
  await finishRun(runId, {
    status: runStatus,
    itemsFound: found,
    itemsProcessed: processed,
    error: runError,
  });
  runLog.info("Corrida de polling de entrantes terminada", {
    status: runStatus,
    found,
    processed,
  });

  return json(
    { ok: runStatus === "ok", runId, found, processed },
    runStatus === "ok" ? 200 : 500,
  );
}

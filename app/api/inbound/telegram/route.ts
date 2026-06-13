/**
 * Webhook entrante de Telegram (worker de Railway).
 *
 * `POST /api/inbound/telegram` recibe los DMs que el worker de Telegram (el
 * cliente MTProto que corre en Railway) reenvía cuando le llega un mensaje.
 * Normaliza el payload con el adapter de Telegram y se lo pasa al motor de
 * conversación, que lo rutea a su conversación y, si el autopilot está activo,
 * responde.
 *
 * Diseño (webhook resiliente, idéntico a `/api/inbound/whatsapp`):
 *  - **Siempre 2xx salvo auth**: devuelve 200 ante JSON inválido, eventos que
 *    no son un mensaje entrante y errores internos, para no provocar reintentos
 *    del worker. Sólo un secreto inválido corta con 401.
 *  - **Idempotencia**: la deduplicación por `channel_message_id` vive en el
 *    motor, así un reenvío del mismo mensaje no genera una respuesta doble.
 *
 * Está protegida por el header `x-webhook-secret`.
 */

import { ingestInbound } from "@/lib/conversation/engine";
import { getChannel } from "@/lib/channels";
import { finishRun, startRun } from "@/lib/db/runs";
import { createLogger } from "@/lib/logger";
import { verifyWebhookSecret } from "@/lib/security";
import { loadAutopilotSettings } from "@/lib/settings";

/** Cada webhook entrante se procesa sin caché. */
export const dynamic = "force-dynamic";
/** Un entrante dispara a lo sumo un turno del agente: alcanza con el techo estándar. */
export const maxDuration = 300;

const log = createLogger({ route: "inbound/telegram" });

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  // Auth es lo único que corta el webhook: sin secreto válido, 401.
  if (!verifyWebhookSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  // JSON inválido → 200 e ignorado: no queremos que el worker reintente.
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    log.warn("Payload de webhook con JSON inválido; ignorado");
    return json({ ignored: true }, 200);
  }

  // El adapter decide si el evento es un mensaje entrante normalizable. Si no
  // (envío propio, evento de servicio), se ignora con 200.
  const adapter = getChannel("telegram");
  const inbound = adapter?.parseInbound?.(payload);
  if (!inbound) {
    return json({ ignored: true }, 200);
  }

  const runId = await startRun("inbound");
  const runLog = log.child({ runId, channel: "telegram", contactKey: inbound.contactKey });

  try {
    const s = await loadAutopilotSettings();
    const r = await ingestInbound(inbound, s);
    await finishRun(runId, {
      status: "ok",
      itemsFound: 1,
      itemsProcessed: r.handled ? 1 : 0,
    });
    runLog.info("Entrante de Telegram procesado", r);
    return json({ ok: true, runId, ...r }, 200);
  } catch (err) {
    // Error interno: se loguea y se cierra la corrida, pero igual devolvemos
    // 200 para evitar una tormenta de reintentos del worker.
    const error = err instanceof Error ? err.message : String(err);
    runLog.error("Fallo al procesar el entrante de Telegram", { error });
    await finishRun(runId, { status: "error", itemsFound: 1, error });
    return json({ ok: false, runId, error }, 200);
  }
}

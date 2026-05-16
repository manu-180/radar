/**
 * Webhook de Wassenger: estados de entrega de WhatsApp.
 *
 * `POST /api/webhooks/wassenger` recibe los eventos que Wassenger dispara
 * cuando un mensaje cambia de estado (entregado, fallido, …) y los refleja en
 * la tabla `notifications`, identificando la fila por el `wassenger_id` que se
 * guardó al enviar.
 *
 * Seguridad: el endpoint **debe** estar autenticado. Wassenger no firma sus
 * webhooks, así que el secreto compartido `WASSENGER_WEBHOOK_SECRET` se manda
 * en el header `x-webhook-secret` o como query param (`?secret=` / `?token=`)
 * de la URL configurada en Wassenger. Sin un secreto correcto, la respuesta es
 * `401` — de lo contrario cualquiera podría falsear estados de entrega.
 *
 * El handler responde `200` rápido: Wassenger reintenta los webhooks no-2xx,
 * así que un evento que no reconocemos igual se confirma para cortar el
 * reintento.
 */

import { timingSafeEqualStr } from "@/lib/security";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { getAdminClient } from "@/lib/supabase/admin";

/** El webhook se ejecuta siempre en vivo, sin caché. */
export const dynamic = "force-dynamic";

const log = createLogger({ route: "webhooks/wassenger" });

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * Verifica que el request traiga el `WASSENGER_WEBHOOK_SECRET` correcto.
 *
 * Acepta el secreto en el header `x-webhook-secret` o en un query param de la
 * URL (`secret` o `token`); la comparación es siempre timing-safe.
 */
function verifyWebhookSecret(request: Request): boolean {
  const url = new URL(request.url);
  const provided =
    request.headers.get("x-webhook-secret") ??
    url.searchParams.get("secret") ??
    url.searchParams.get("token");
  if (!provided) return false;
  return timingSafeEqualStr(provided, env.WASSENGER_WEBHOOK_SECRET);
}

/**
 * Traduce el `event` de Wassenger al estado de `notifications`.
 *
 * Wassenger nombra sus eventos como `message:out:<estado>` (ej.
 * `message:out:delivered`, `message:out:failed`). Solo nos interesan los
 * estados terminales; cualquier otro evento se ignora (devuelve `null`).
 */
function eventToStatus(event: string): "delivered" | "failed" | null {
  const e = event.toLowerCase();
  if (e.includes("delivered")) return "delivered";
  if (e.includes("failed") || e.includes("error")) return "failed";
  return null;
}

/** Extrae, de forma defensiva, el id de mensaje del payload de Wassenger. */
function extractMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  // El id puede venir en `data.id` (forma habitual) o suelto en `id`.
  const data = obj.data;
  if (data && typeof data === "object" && "id" in data) {
    const id = (data as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  if (typeof obj.id === "string" && obj.id.length > 0) return obj.id;
  return null;
}

/** Extrae el nombre del evento del payload de Wassenger. */
function extractEvent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const event = (payload as Record<string, unknown>).event;
  return typeof event === "string" && event.length > 0 ? event : null;
}

export async function POST(request: Request): Promise<Response> {
  // Autenticación primero: un POST sin el secreto correcto no se procesa.
  if (!verifyWebhookSecret(request)) {
    log.warn("Webhook de Wassenger rechazado: secreto inválido o ausente");
    return json({ error: "No autorizado" }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // Un body ilegible no se va a recuperar reintentando: respondemos 200
    // para cortar el reintento, pero lo dejamos en el log.
    log.warn("Webhook de Wassenger con body no-JSON; ignorado");
    return json({ ok: true, ignored: "body inválido" }, 200);
  }

  const event = extractEvent(payload);
  const status = event ? eventToStatus(event) : null;

  // Evento que no es un estado terminal de entrega: se confirma sin tocar nada.
  if (!status) {
    return json({ ok: true, ignored: event ?? "evento desconocido" }, 200);
  }

  const wassengerId = extractMessageId(payload);
  if (!wassengerId) {
    log.warn("Webhook de Wassenger sin id de mensaje; ignorado", { event });
    return json({ ok: true, ignored: "sin id de mensaje" }, 200);
  }

  const { data, error } = await getAdminClient()
    .from("notifications")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("wassenger_id", wassengerId)
    .select("id");

  if (error) {
    log.error("No se pudo actualizar la notificación", {
      wassengerId,
      status,
      error: error.message,
    });
    return json({ error: "No se pudo actualizar la notificación" }, 500);
  }

  const updated = data?.length ?? 0;
  if (updated === 0) {
    // El mensaje no es uno de los nuestros, o el webhook llegó antes de que se
    // guardara la fila: no es un error, pero conviene registrarlo.
    log.warn("Webhook sin notificación asociada", { wassengerId, status });
  } else {
    log.info("Estado de entrega actualizado", { wassengerId, status, updated });
  }

  return json({ ok: true, status, updated }, 200);
}

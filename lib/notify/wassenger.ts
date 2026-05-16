/**
 * Cliente de Wassenger para enviar mensajes de WhatsApp.
 *
 * Módulo puro y reutilizable: lo usan la ruta de notificación (que avisa los
 * leads nuevos) y el monitoreo de salud (que manda alertas del sistema). Solo
 * sabe disparar un mensaje y devolver el id que asigna Wassenger; no decide
 * *qué* mandar ni *a quién* — eso es responsabilidad del llamador.
 *
 * La API de Wassenger autentica con un header propio llamado, literalmente,
 * `Token`. El endpoint de chat directo acepta `{ phone, message, priority }`.
 */

import "server-only";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";

/** Endpoint de envío de mensajes de Wassenger. */
const MESSAGES_URL = "https://api.wassenger.com/v1/messages";

const logger = createLogger({ module: "notify/wassenger" });

/**
 * Extrae el id del mensaje de la respuesta de Wassenger.
 *
 * La API responde con el objeto del mensaje creado (o, en algunos casos, un
 * array con ese único objeto). En ambas formas el id viaja en el campo `id`.
 */
function extractMessageId(payload: unknown): string | null {
  const obj = Array.isArray(payload) ? payload[0] : payload;
  if (obj && typeof obj === "object" && "id" in obj) {
    const id = (obj as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * Envía un mensaje de WhatsApp a un número en formato E.164.
 *
 * Usa {@link fetchWithRetry}, que ya reintenta ante `429` y errores
 * transitorios. Ante un fallo no recuperable —o si la respuesta no trae un id
 * de mensaje— lanza un error descriptivo.
 *
 * @param phone   Número destino en formato E.164, ej. `+5491112345678`.
 * @param message Texto del mensaje (admite el formato de WhatsApp).
 * @returns El id que Wassenger asignó al mensaje.
 */
export async function sendWhatsApp(
  phone: string,
  message: string,
): Promise<{ id: string }> {
  let response: Response;
  try {
    response = await fetchWithRetry(MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Token: env.WASSENGER_API_KEY,
      },
      body: JSON.stringify({ phone, message, priority: "high" }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("Envío de WhatsApp falló", { phone, error: detail });
    throw new Error(
      `sendWhatsApp: no se pudo enviar el mensaje a ${phone}: ${detail}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("Respuesta de Wassenger ilegible", { phone, error: detail });
    throw new Error(
      `sendWhatsApp: la respuesta de Wassenger no es JSON válido: ${detail}`,
    );
  }

  const id = extractMessageId(payload);
  if (!id) {
    logger.error("Wassenger respondió sin un id de mensaje", { phone });
    throw new Error(
      "sendWhatsApp: Wassenger aceptó la request pero no devolvió un id de mensaje.",
    );
  }

  logger.info("WhatsApp enviado", { phone, wassengerId: id });
  return { id };
}

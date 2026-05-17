/**
 * Cliente de Evolution API para enviar mensajes de WhatsApp.
 *
 * Reemplaza al cliente de Wassenger: los avisos salen ahora por una instancia
 * de **Evolution API** propia del dueño (la misma infraestructura de "senders"
 * del proyecto `agente-busca-clientes`). Módulo puro y reutilizable: lo usan la
 * ruta de notificación y el monitoreo de salud. Sólo sabe disparar un mensaje
 * desde una instancia fija y devolver el id que asigna Evolution; no decide qué
 * mandar ni a quién.
 *
 * El Lead Detector sólo avisa al dueño —un destinatario, bajo volumen—, así que
 * no necesita el pool de senders ni la rotación: le alcanza una sola instancia,
 * configurada en `EVOLUTION_INSTANCE`.
 *
 * Contrato de Evolution API (v2):
 *  - Auth:   header `apikey`.
 *  - Envío:  `POST {EVOLUTION_API_URL}/message/sendText/{instancia}` con body
 *            `{ number, text }`; responde `{ key: { id } }`.
 *  - Estado: `GET {EVOLUTION_API_URL}/instance/connectionState/{instancia}`
 *            responde `{ instance: { state } }` (`open` = conectada).
 */

import "server-only";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";

const logger = createLogger({ module: "notify/evolution" });

/** URL base de Evolution, sin barras finales. */
function baseUrl(): string {
  return env.EVOLUTION_API_URL.replace(/\/+$/, "");
}

/**
 * Normaliza un teléfono al formato que espera Evolution: sólo dígitos, con
 * código de país, sin `+` ni separadores. `+54 9 11 1234-5678` → `5491112345678`.
 */
function toEvolutionNumber(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

/**
 * Lee, best-effort, el estado de conexión de la instancia.
 *
 * Devuelve el `state` informado por Evolution, o `null` si no se pudo
 * determinar (red caída, timeout, instancia inexistente). Un `null` **no**
 * bloquea el envío: el `POST` siguiente tiene su propio manejo de errores. Sólo
 * un estado conocido distinto de `open` aborta antes de enviar.
 */
async function readInstanceState(): Promise<string | null> {
  const url =
    `${baseUrl()}/instance/connectionState/` +
    encodeURIComponent(env.EVOLUTION_INSTANCE);
  try {
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: { apikey: env.EVOLUTION_API_KEY },
      timeoutMs: 10_000,
      retries: 0,
    });
    const data = (await response.json()) as { instance?: { state?: string } };
    return data?.instance?.state ?? null;
  } catch (err) {
    logger.warn("No se pudo verificar el estado de la instancia de Evolution", {
      instance: env.EVOLUTION_INSTANCE,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Extrae el id del mensaje de la respuesta de Evolution (`{ key: { id } }`). */
function extractMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const key = (payload as { key?: unknown }).key;
  if (key && typeof key === "object" && "id" in key) {
    const id = (key as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * Envía un mensaje de WhatsApp a un número (en formato E.164) desde la
 * instancia de Evolution configurada.
 *
 * Antes de enviar verifica —best-effort— que la instancia esté conectada: si
 * está caída, lanza un error accionable en vez de un fallo opaco de la API. El
 * envío usa {@link fetchWithRetry} con timeout y un reintento ante fallos
 * transitorios.
 *
 * @param phone   Número destino en formato E.164, ej. `+5491112345678`.
 * @param message Texto del mensaje (admite el formato de WhatsApp).
 * @returns El id que Evolution asignó al mensaje (`null` si no lo devolvió).
 * @throws Si la instancia no está conectada o el envío falla.
 */
export async function sendWhatsApp(
  phone: string,
  message: string,
): Promise<{ id: string | null }> {
  const instance = env.EVOLUTION_INSTANCE;

  // Pre-flight: si la instancia está caída, fallar con un mensaje accionable.
  const state = await readInstanceState();
  if (state !== null && state !== "open") {
    logger.error("La instancia de Evolution no está conectada", {
      instance,
      state,
    });
    throw new Error(
      `sendWhatsApp: la instancia de Evolution "${instance}" no está ` +
        `conectada (estado: ${state}). Reconectala escaneando el QR desde el ` +
        `panel de senders.`,
    );
  }

  let response: Response;
  try {
    response = await fetchWithRetry(
      `${baseUrl()}/message/sendText/${encodeURIComponent(instance)}`,
      {
        method: "POST",
        headers: {
          apikey: env.EVOLUTION_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ number: toEvolutionNumber(phone), text: message }),
        // 1 reintento: equilibra recuperar un fallo transitorio contra el
        // riesgo de doble envío si el mensaje salió y se perdió la respuesta.
        timeoutMs: 15_000,
        retries: 1,
      },
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("Envío de WhatsApp falló", { phone, instance, error: detail });
    throw new Error(
      `sendWhatsApp: no se pudo enviar el mensaje a ${phone} ` +
        `(instancia ${instance}): ${detail}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("Respuesta de Evolution ilegible", { phone, error: detail });
    throw new Error(
      `sendWhatsApp: la respuesta de Evolution no es JSON válido: ${detail}`,
    );
  }

  const id = extractMessageId(payload);
  if (id) {
    logger.info("WhatsApp enviado", { phone, instance, messageId: id });
  } else {
    // Evolution aceptó el request (2xx) pero no devolvió un id: el envío se da
    // por hecho, sólo se pierde el id de tracking.
    logger.warn("Evolution aceptó el envío pero no devolvió un id de mensaje", {
      phone,
      instance,
    });
  }
  return { id };
}

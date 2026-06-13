/**
 * Adaptador de canal: Telegram (vía el worker de Railway sobre HTTP).
 *
 * La app de Next.js no puede sostener una conexión MTProto (es serverless), así
 * que el envío y la recepción de DMs van delegados a un worker persistente en
 * Railway. Este adaptador habla con el worker por HTTP:
 *  - Saliente: `POST {TELEGRAM_WORKER_URL}/send` con el `userId`/`accessHash`.
 *  - Entrante: el worker postea a nuestro webhook el mensaje ya normalizado;
 *    `parseInbound` lo mapea a {@link InboundMessage}.
 *
 * El header `x-webhook-secret` autentica a la app contra el worker (es el mismo
 * `WEBHOOK_SECRET` con el que el worker firma sus posts entrantes). Si falta la
 * URL del worker o el secreto, el canal queda inerte.
 */

import "server-only";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import type { Channel } from "@/types/autopilot";

import { registerChannel } from "./registry";
import type { ChannelAdapter, InboundMessage, OutboundTarget } from "./types";

const CHANNEL: Channel = "telegram";

const logger = createLogger({ module: "channels/telegram" });

/** Timeout del request al worker, en ms. */
const SEND_TIMEOUT_MS = 15_000;

/** Reintentos del request al worker (además del intento inicial). */
const SEND_RETRIES = 1;

/** URL base del worker, sin barras finales. */
function workerBaseUrl(): string {
  return (env.TELEGRAM_WORKER_URL ?? "").replace(/\/+$/, "");
}

/** Acceso seguro a una propiedad de un objeto desconocido. */
function prop(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * Adaptador de Telegram.
 *
 * Ver el encabezado del módulo para el comportamiento. Recibe por webhook
 * (`parseInbound`), no por polling: el worker empuja los entrantes.
 */
export const telegramAdapter: ChannelAdapter = {
  channel: CHANNEL,

  isConfigured(): boolean {
    return Boolean(env.TELEGRAM_WORKER_URL && env.WEBHOOK_SECRET);
  },

  async send(target: OutboundTarget, text: string): Promise<{ id: string | null }> {
    // El `accessHash` viaja en `contactRef` (lo arma la fuente al detectar el
    // lead); puede faltar si el peer ya es conocido por el worker.
    const accessHash = (target.contactRef?.accessHash as unknown) ?? null;

    const response = await fetchWithRetry(`${workerBaseUrl()}/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": env.WEBHOOK_SECRET ?? "",
      },
      body: JSON.stringify({
        userId: target.contactKey,
        accessHash,
        text,
      }),
      timeoutMs: SEND_TIMEOUT_MS,
      retries: SEND_RETRIES,
    });

    const payload = (await response.json()) as { id?: string | null };
    const id = typeof payload?.id === "string" ? payload.id : null;

    logger.info("Saliente de Telegram enviado al worker", {
      userId: target.contactKey,
      messageId: id,
    });

    return { id };
  },

  parseInbound(payload: unknown): InboundMessage | null {
    // El worker postea `{ userId, accessHash, username, firstName, text, messageId }`.
    const text = prop(payload, "text");
    if (typeof text !== "string" || text.length === 0) return null;

    const userId = prop(payload, "userId");
    if (userId === undefined || userId === null) return null;

    const accessHash = prop(payload, "accessHash") ?? null;
    const username = prop(payload, "username");
    const firstName = prop(payload, "firstName");
    const messageId = prop(payload, "messageId");

    // Handle legible: `@username` si lo hay, si no el nombre de pila.
    const contactHandle =
      typeof username === "string" && username.length > 0
        ? `@${username}`
        : typeof firstName === "string" && firstName.length > 0
          ? firstName
          : null;

    return {
      channel: CHANNEL,
      contactKey: String(userId),
      contactRef: { accessHash },
      contactHandle,
      text,
      providerMessageId:
        messageId === undefined || messageId === null
          ? null
          : String(messageId),
    };
  },
};

registerChannel(telegramAdapter);

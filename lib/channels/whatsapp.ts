/**
 * Adaptador de canal: WhatsApp (vía Evolution API).
 *
 * Es el canal más simple y el único que ya funciona end-to-end hoy: reusa el
 * cliente de Evolution del proyecto ({@link sendWhatsApp}) para los salientes y
 * parsea el webhook de Evolution API v2 para los entrantes. No mantiene estado
 * propio ni credenciales nuevas: las variables `EVOLUTION_*` son requeridas y
 * siempre están presentes, así que el canal está configurado por definición.
 *
 * Contrato del webhook entrante de Evolution (v2):
 *  - Evento `messages.upsert` con `data.key` y `data.message`.
 *  - `data.key.remoteJid`  → el JID del remitente (`<digits>@s.whatsapp.net`).
 *  - `data.key.fromMe`     → `true` si lo mandamos nosotros (se ignora).
 *  - `data.key.id`         → id del mensaje en el proveedor (para deduplicar).
 *  - `data.message.conversation` o `data.message.extendedTextMessage.text` → texto.
 */

import "server-only";

import { createLogger } from "@/lib/logger";
import { sendWhatsApp } from "@/lib/notify/evolution";
import type { Channel } from "@/types/autopilot";

import { registerChannel } from "./registry";
import type { ChannelAdapter, InboundMessage, OutboundTarget } from "./types";

const CHANNEL: Channel = "whatsapp";

const logger = createLogger({ module: "channels/whatsapp" });

/**
 * Extrae los dígitos del `remoteJid`: descarta el sufijo `@s.whatsapp.net` (o
 * cualquier `@...`) y deja sólo el número. `5491112345678@s.whatsapp.net` →
 * `5491112345678`. Devuelve `null` si no quedan dígitos.
 */
function digitsFromJid(remoteJid: unknown): string | null {
  if (typeof remoteJid !== "string") return null;
  const local = remoteJid.split("@", 1)[0] ?? "";
  const digits = local.replace(/[^0-9]/g, "");
  return digits.length > 0 ? digits : null;
}

/** Acceso seguro a una propiedad de un objeto desconocido. */
function prop(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/**
 * Extrae el texto de un `data.message` de Evolution, contemplando los dos
 * formatos usuales: `conversation` (texto plano) y `extendedTextMessage.text`
 * (texto con metadata, ej. respuestas o links). Devuelve `null` si no hay texto.
 */
function extractText(message: unknown): string | null {
  const conversation = prop(message, "conversation");
  if (typeof conversation === "string" && conversation.length > 0) {
    return conversation;
  }
  const extended = prop(message, "extendedTextMessage");
  const extendedText = prop(extended, "text");
  if (typeof extendedText === "string" && extendedText.length > 0) {
    return extendedText;
  }
  return null;
}

/**
 * Adaptador de WhatsApp.
 *
 * Ver el encabezado del módulo para el comportamiento. `isConfigured` es siempre
 * `true`: las credenciales de Evolution son requeridas por `lib/env.ts`.
 */
export const whatsappAdapter: ChannelAdapter = {
  channel: CHANNEL,

  isConfigured(): boolean {
    return true;
  },

  async send(target: OutboundTarget, text: string): Promise<{ id: string | null }> {
    // `contactKey` es el teléfono en dígitos/E.164; Evolution lo normaliza.
    return sendWhatsApp(target.contactKey, text);
  },

  parseInbound(payload: unknown): InboundMessage | null {
    // El cuerpo de Evolution v2 trae `event` y `data`. Sólo nos interesan los
    // `messages.upsert` (mensajes nuevos); el resto de eventos se descarta.
    const event = prop(payload, "event");
    if (event !== "messages.upsert") return null;

    const data = prop(payload, "data");
    const key = prop(data, "key");

    // Mensaje propio (lo enviamos nosotros): no es un entrante, se ignora.
    if (prop(key, "fromMe") === true) return null;

    const digits = digitsFromJid(prop(key, "remoteJid"));
    if (!digits) return null;

    const text = extractText(prop(data, "message"));
    if (!text) return null;

    const rawId = prop(key, "id");
    const providerMessageId =
      typeof rawId === "string" && rawId.length > 0 ? rawId : null;

    logger.info("Entrante de WhatsApp parseado", { digits, providerMessageId });

    return {
      channel: CHANNEL,
      contactKey: digits,
      contactHandle: `+${digits}`,
      text,
      providerMessageId,
    };
  },
};

registerChannel(whatsappAdapter);

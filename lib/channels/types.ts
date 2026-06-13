/**
 * Tipos base del patrón de adaptadores de **canal** (v2).
 *
 * Es el espejo del patrón de fuentes (`lib/sources/types.ts`) pero del lado del
 * envío: cada canal por el que el closer puede conversar (WhatsApp, Telegram,
 * Bluesky, Reddit) implementa {@link ChannelAdapter}. El motor de conversación
 * es agnóstico al canal: habla siempre contra esta interfaz.
 */

import type { Channel } from "@/types/autopilot";

/**
 * Mensaje entrante ya normalizado, sin importar el canal de origen. Lo produce
 * un webhook (`parseInbound`) o un polling (`pollInbound`) y lo consume el
 * motor de conversación para rutearlo a la conversación correcta.
 */
export interface InboundMessage {
  /** Canal de origen. */
  channel: Channel;
  /** Clave de ruteo del remitente (matchea `conversations.contact_key`). */
  contactKey: string;
  /** Direccionamiento completo del remitente (por si hay que crear la conversación). */
  contactRef?: Record<string, unknown>;
  /** Handle legible del remitente (`@user`, `+54…`). */
  contactHandle?: string | null;
  /** Texto del mensaje. */
  text: string;
  /** ID del mensaje en el proveedor, para deduplicar; `null` si no hay. */
  providerMessageId: string | null;
}

/** Destino de un envío: lo mínimo que un adapter necesita para mandar. */
export interface OutboundTarget {
  /** Clave de ruteo del destinatario en el canal. */
  contactKey: string;
  /** Direccionamiento completo del destinatario, opaco por canal. */
  contactRef: Record<string, unknown>;
  /** Handle legible del destinatario; `null` si no hay. */
  contactHandle: string | null;
}

/**
 * Contrato que implementa cada canal de conversación.
 *
 * Un canal puede recibir entrantes por **webhook** (`parseInbound`) o por
 * **polling** (`pollInbound`); implementa el que corresponda. `send` es
 * obligatorio: es la única forma del motor de mandar un mensaje.
 */
export interface ChannelAdapter {
  /** Identificador estable del canal. */
  channel: Channel;
  /**
   * ¿Está configurado (credenciales presentes)? Si devuelve `false`, el canal
   * queda inerte: ni se envía ni se sondea por él, pero la app arranca igual.
   */
  isConfigured(): boolean;
  /**
   * Manda un mensaje saliente al destinatario.
   *
   * @returns El id que el proveedor asignó al mensaje (`null` si no lo devolvió).
   * @throws Si el envío falla (el motor lo traduce a un mensaje `failed`).
   */
  send(target: OutboundTarget, text: string): Promise<{ id: string | null }>;
  /** Parsea el payload de un webhook entrante a un {@link InboundMessage}. */
  parseInbound?(payload: unknown): InboundMessage | null;
  /** Trae los entrantes nuevos por polling (canales sin webhook). */
  pollInbound?(): Promise<InboundMessage[]>;
}

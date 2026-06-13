/**
 * Tipos compartidos de la capa de **Autopilot** (v2): conversaciones, mensajes
 * y los campos de contacto/engage que la migración 0009 agrega a `leads`.
 *
 * El cliente de Supabase del proyecto es **sin tipar** (`getAdminClient`
 * devuelve un `SupabaseClient` sin el genérico `Database`), así que —igual que
 * el resto del código— los resultados de las queries se castean a estos tipos
 * en vez de derivarlos de `types/database.ts`. Esto evita tocar el archivo
 * autogenerado y sobrevive a una regeneración futura (cuando se regenere desde
 * la DB, estas tablas aparecerán solas y estos tipos quedan como conveniencia).
 */

import type { Json, Tables } from "@/types/database";

/** Canales por los que el closer puede conversar. */
export type Channel = "telegram" | "bluesky" | "whatsapp" | "reddit";

/** Todos los canales conocidos, en orden de preferencia de contacto. */
export const CHANNELS: readonly Channel[] = [
  "telegram",
  "bluesky",
  "whatsapp",
  "reddit",
] as const;

/** Estado del lead en la cola de primer contacto (`leads.engage_status`). */
export type EngageStatus =
  | "none"
  | "pending"
  | "engaging"
  | "engaged"
  | "skipped";

/** Estado de una conversación (`conversations.status`). */
export type ConversationStatus =
  | "pending_outreach"
  | "awaiting_reply"
  | "active"
  | "awaiting_owner"
  | "snoozed"
  | "wants_draft"
  | "handed_off"
  | "won"
  | "lost"
  | "disqualified"
  | "paused"
  | "failed";

/** Etapa del embudo dentro de una conversación (`conversations.stage`). */
export type ConversationStage =
  | "outreach"
  | "greeted"
  | "discovery"
  | "offer"
  | "negotiation"
  | "scheduling"
  | "draft_requested"
  | "closed";

export type MessageDirection = "inbound" | "outbound";
export type MessageRole = "lead" | "agent" | "owner" | "system";
export type MessageStatus =
  | "received"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed";

/**
 * Cómo contactar a un lead en un canal. Lo arma la fuente durante el polling
 * (sólo las fuentes cuyo autor es contactable lo producen).
 */
export interface LeadContact {
  /** Canal por el que se puede escribir a esta persona. */
  channel: Channel;
  /** Clave de ruteo en el canal: phone digits, tg user id, bsky DID, username. */
  key: string;
  /** Direccionamiento completo, opaco por canal (ej. tg `access_hash`). */
  ref: Record<string, unknown>;
  /** Display para el panel (`@user`, `+54…`); `null` si no hay. */
  handle: string | null;
}

/**
 * Campos que 0009 agrega a `leads` y que el tipo generado todavía no incluye.
 * Se intersectan con `Tables<"leads">` para tener la fila completa de v2.
 */
export interface LeadContactFields {
  contact_channel: string | null;
  contact_key: string | null;
  contact_ref: Json | null;
  contact_handle: string | null;
  engage_status: EngageStatus;
  engage_claimed_at: string | null;
  engaged_at: string | null;
}

/** Fila completa de `leads`, ya con los campos de contacto/engage de v2. */
export type Lead = Tables<"leads"> & LeadContactFields;

/** Fila de `conversations`. */
export interface Conversation {
  id: number;
  lead_id: number;
  channel: Channel;
  contact_key: string;
  contact_ref: Json;
  contact_handle: string | null;
  status: ConversationStatus;
  stage: ConversationStage;
  interest_level: number;
  autopilot: boolean;
  message_count: number;
  outbound_count: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  next_action_at: string | null;
  claimed_at: string | null;
  summary: string | null;
  last_error: string | null;
  meta: Json;
  created_at: string;
  updated_at: string;
}

/** Fila de `messages`. */
export interface Message {
  id: number;
  conversation_id: number;
  direction: MessageDirection;
  role: MessageRole;
  body: string;
  channel_message_id: string | null;
  status: MessageStatus;
  error: string | null;
  ai_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ai_cost_usd: number | null;
  interest_level: number | null;
  created_at: string;
  sent_at: string | null;
}

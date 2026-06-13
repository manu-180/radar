/**
 * Persistencia de conversaciones, mensajes y la cola de engage.
 *
 * Capa de datos pura de v2 (espejo de `lib/db/leads.ts` / `runs.ts`): sólo toca
 * la base, sin lógica de IA, canales ni decisiones. El motor de conversación
 * (`lib/conversation/engine.ts`) y las rutas orquestan usando estas funciones.
 *
 * El cliente de Supabase es sin tipar, así que los resultados se castean a los
 * tipos de `@/types/autopilot`. Los contadores (`message_count`,
 * `outbound_count`, `last_*_at`) los mantiene un trigger en la DB (migración
 * 0009): acá no se tocan a mano.
 */

import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import type {
  Channel,
  Conversation,
  ConversationStage,
  ConversationStatus,
  EngageStatus,
  Lead,
  Message,
  MessageDirection,
  MessageRole,
  MessageStatus,
} from "@/types/autopilot";

function db() {
  return getAdminClient();
}

// ─── leads (cola de engage) ──────────────────────────────────────────────────

/** Trae un lead completo (con los campos de contacto/engage de v2). */
export async function getLead(id: number): Promise<Lead | null> {
  const { data, error } = await db().from("leads").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getLead(${id}): ${error.message}`);
  return (data as Lead | null) ?? null;
}

/** Fija el `engage_status` de un lead (y `engaged_at` cuando pasa a `engaged`). */
export async function setLeadEngageStatus(
  id: number,
  status: EngageStatus,
): Promise<void> {
  const patch: Record<string, unknown> = { engage_status: status };
  if (status === "engaged") patch.engaged_at = new Date().toISOString();
  const { error } = await db().from("leads").update(patch).eq("id", id);
  if (error) throw new Error(`setLeadEngageStatus(${id}, ${status}): ${error.message}`);
}

/**
 * Reclama un lote de leads listos para el primer contacto (RPC resiliente
 * `claim_leads_to_engage`): clasificados, contactables y que califican.
 */
export async function claimLeadsToEngage(
  batchSize: number,
  categories: string[],
  minScore: number,
): Promise<Lead[]> {
  const { data, error } = await db().rpc("claim_leads_to_engage", {
    batch_size: batchSize,
    cats: categories,
    min_score: minScore,
  });
  if (error) throw new Error(`claimLeadsToEngage: ${error.message}`);
  return (data ?? []) as Lead[];
}

// ─── conversations ───────────────────────────────────────────────────────────

/** Trae una conversación por id. */
export async function getConversation(id: number): Promise<Conversation | null> {
  const { data, error } = await db()
    .from("conversations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getConversation(${id}): ${error.message}`);
  return (data as Conversation | null) ?? null;
}

/** Encuentra la conversación de un remitente en un canal (ruteo de entrantes). */
export async function findConversationByContact(
  channel: Channel,
  contactKey: string,
): Promise<Conversation | null> {
  const { data, error } = await db()
    .from("conversations")
    .select("*")
    .eq("channel", channel)
    .eq("contact_key", contactKey)
    .maybeSingle();
  if (error) {
    throw new Error(`findConversationByContact(${channel}): ${error.message}`);
  }
  return (data as Conversation | null) ?? null;
}

/** Datos para crear una conversación. */
export interface NewConversation {
  lead_id: number;
  channel: Channel;
  contact_key: string;
  contact_ref: Record<string, unknown>;
  contact_handle: string | null;
  autopilot: boolean;
  status?: ConversationStatus;
}

/** Crea una conversación. Idempotente ante carrera vía el índice único (channel, contact_key). */
export async function createConversation(
  input: NewConversation,
): Promise<Conversation> {
  const { data, error } = await db()
    .from("conversations")
    .insert({
      lead_id: input.lead_id,
      channel: input.channel,
      contact_key: input.contact_key,
      contact_ref: input.contact_ref,
      contact_handle: input.contact_handle,
      autopilot: input.autopilot,
      status: input.status ?? "pending_outreach",
    })
    .select("*")
    .single();
  if (error) throw new Error(`createConversation: ${error.message}`);
  return data as Conversation;
}

/** Campos actualizables de una conversación (los contadores los maneja el trigger). */
export interface ConversationPatch {
  status?: ConversationStatus;
  stage?: ConversationStage;
  interest_level?: number;
  autopilot?: boolean;
  next_action_at?: string | null;
  summary?: string | null;
  last_error?: string | null;
  meta?: Record<string, unknown>;
}

/** Aplica un patch a una conversación y refresca `updated_at`. */
export async function updateConversation(
  id: number,
  patch: ConversationPatch,
): Promise<void> {
  const { error } = await db()
    .from("conversations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`updateConversation(${id}): ${error.message}`);
}

/**
 * Toma una conversación para correr un turno (RPC `claim_conversation_for_turn`).
 * Devuelve la fila si la reclamó, o `null` si ya hay un turno en vuelo.
 */
export async function claimConversationForTurn(
  id: number,
): Promise<Conversation | null> {
  const { data, error } = await db().rpc("claim_conversation_for_turn", {
    conv_id: id,
  });
  if (error) throw new Error(`claimConversationForTurn(${id}): ${error.message}`);
  const rows = (data ?? []) as Conversation[];
  return rows[0] ?? null;
}

/** Libera el claim de turno de una conversación (`claimed_at = null`). */
export async function releaseConversation(id: number): Promise<void> {
  const { error } = await db()
    .from("conversations")
    .update({ claimed_at: null })
    .eq("id", id);
  if (error) throw new Error(`releaseConversation(${id}): ${error.message}`);
}

/** Reclama conversaciones con un follow-up vencido (RPC `claim_conversations_due`). */
export async function claimConversationsDue(
  batchSize: number,
): Promise<Conversation[]> {
  const { data, error } = await db().rpc("claim_conversations_due", {
    batch_size: batchSize,
  });
  if (error) throw new Error(`claimConversationsDue: ${error.message}`);
  return (data ?? []) as Conversation[];
}

// ─── messages ────────────────────────────────────────────────────────────────

/** Datos para registrar un mensaje. */
export interface NewMessage {
  conversation_id: number;
  direction: MessageDirection;
  role: MessageRole;
  body: string;
  channel_message_id?: string | null;
  status: MessageStatus;
  error?: string | null;
  ai_model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  ai_cost_usd?: number | null;
  interest_level?: number | null;
  sent_at?: string | null;
}

/** Inserta un mensaje. El trigger de la DB actualiza los contadores de la conversación. */
export async function appendMessage(input: NewMessage): Promise<Message> {
  const { data, error } = await db()
    .from("messages")
    .insert({
      conversation_id: input.conversation_id,
      direction: input.direction,
      role: input.role,
      body: input.body,
      channel_message_id: input.channel_message_id ?? null,
      status: input.status,
      error: input.error ?? null,
      ai_model: input.ai_model ?? null,
      input_tokens: input.input_tokens ?? null,
      output_tokens: input.output_tokens ?? null,
      ai_cost_usd: input.ai_cost_usd ?? null,
      interest_level: input.interest_level ?? null,
      sent_at: input.sent_at ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`appendMessage: ${error.message}`);
  return data as Message;
}

/**
 * Registra un entrante deduplicando por `channel_message_id`. Devuelve el
 * mensaje insertado, o `null` si ya existía (webhook reintentado). Cuando no hay
 * `channel_message_id`, inserta siempre (no se puede deduplicar).
 */
export async function appendInboundDeduped(
  conversationId: number,
  text: string,
  providerMessageId: string | null,
): Promise<Message | null> {
  if (providerMessageId) {
    const { data: existing, error: exErr } = await db()
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .eq("channel_message_id", providerMessageId)
      .maybeSingle();
    if (exErr) throw new Error(`appendInboundDeduped(check): ${exErr.message}`);
    if (existing) return null;
  }
  return appendMessage({
    conversation_id: conversationId,
    direction: "inbound",
    role: "lead",
    body: text,
    channel_message_id: providerMessageId,
    status: "received",
  });
}

/** Trae los últimos `limit` mensajes de una conversación, en orden cronológico. */
export async function recentMessages(
  conversationId: number,
  limit: number,
): Promise<Message[]> {
  const { data, error } = await db()
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recentMessages(${conversationId}): ${error.message}`);
  const rows = (data ?? []) as Message[];
  return rows.reverse();
}

/** Cuenta los entrantes posteriores a `sinceIso` (para el re-chequeo del turno). */
export async function countInboundSince(
  conversationId: number,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await db()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId)
    .eq("direction", "inbound")
    .gt("created_at", sinceIso);
  if (error) throw new Error(`countInboundSince(${conversationId}): ${error.message}`);
  return count ?? 0;
}

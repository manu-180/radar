/**
 * Motor de conversación: la orquestación del closer de v2.
 *
 * Une las piezas — base (`lib/db/conversations`), cerebro IA (`lib/ai/agent`),
 * canales (`lib/channels`), config (`lib/settings`) y aviso al dueño
 * (`lib/notify/evolution`) — en tres operaciones que disparan las rutas:
 *
 *  - {@link openConversationForLead}  — primer contacto automático (`/api/engage`).
 *  - {@link ingestInbound}            — entra un mensaje del lead (`/api/inbound/*`).
 *  - {@link runConversationFollowup}  — reenganche programado (`/api/followup`).
 *
 * Invariantes:
 *  - **Un turno a la vez por conversación**: `claim_conversation_for_turn` evita
 *    que dos entrantes casi simultáneos generen dos respuestas pisadas.
 *  - **Sin respuestas dobles ante webhooks reintentados**: los entrantes se
 *    deduplican por `channel_message_id`.
 *  - **Nada queda colgado**: el claim del turno se libera siempre (`finally`) y
 *    es resiliente (se re-toma a los 5 min si una función murió).
 *  - **Tope de mensajes**: pasado `agentMaxMessages`, handoff forzado al dueño.
 */

import "server-only";

import "@/lib/channels"; // registra los adapters de canal (efecto de lado)

import {
  DEFAULT_AGENT_MODEL,
  runAgent,
  type AgentLeadContext,
  type AgentOutput,
  type TranscriptTurn,
} from "@/lib/ai/agent";
import { costUsd, roundCost, totalInputTokens, type TokenUsage } from "@/lib/ai/pricing";
import { getChannel } from "@/lib/channels/registry";
import type { InboundMessage, OutboundTarget } from "@/lib/channels/types";
import {
  appendInboundDeduped,
  appendMessage,
  claimConversationForTurn,
  countInboundSince,
  createConversation,
  findConversationByContact,
  getConversation,
  getLead,
  recentMessages,
  releaseConversation,
  setLeadEngageStatus,
  updateConversation,
} from "@/lib/db/conversations";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { sendWhatsApp } from "@/lib/notify/evolution";
import type { AutopilotSettings } from "@/lib/settings";
import type { Channel, Conversation, Lead, MessageRole } from "@/types/autopilot";

const log = createLogger({ module: "conversation/engine" });

/** Mensajes recientes que se mandan al agente como contexto del turno. */
const TRANSCRIPT_LIMIT = 16;
/** Tope de re-disparos encadenados de un turno (entrantes durante el turno). */
const MAX_TURN_LOOP = 3;

/** Estados en los que el autopilot responde un entrante. */
const RESPONDABLE = new Set(["awaiting_reply", "active", "snoozed", "greeted"]);

// ─── helpers ─────────────────────────────────────────────────────────────────

function leadContext(lead: Lead): AgentLeadContext {
  return {
    title: lead.title ?? "",
    body: lead.body ?? "",
    url: lead.url ?? "",
    source: lead.source,
    lang: lead.lang ?? "es",
    suggestedReply: lead.suggested_reply,
  };
}

function buildTranscript(
  messages: { role: MessageRole; body: string }[],
): TranscriptTurn[] {
  return messages.map((m) => ({ role: m.role, text: m.body }));
}

/** Avisa al dueño por WhatsApp; nunca lanza (un aviso fallido no rompe el flujo). */
async function notifyOwner(text: string): Promise<void> {
  try {
    await sendWhatsApp(env.OWNER_WHATSAPP, text);
  } catch (err) {
    log.error("No se pudo avisar al dueño", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Acumulador de datos de IA para persistir en el mensaje saliente. */
interface AiMeta {
  model: string;
  usage: TokenUsage;
  cost: number;
  interest: number | null;
}

/**
 * Manda un mensaje saliente por el canal de la conversación y lo persiste.
 *
 * Persiste el mensaje pase lo que pase (con `status='failed'` si el envío
 * falló), y re-lanza el error para que el llamador decida. Así nunca se manda
 * sin registrarse ni se registra como enviado algo que no salió.
 */
async function sendOutbound(
  conv: Conversation,
  text: string,
  role: MessageRole,
  ai?: AiMeta,
): Promise<string | null> {
  const adapter = getChannel(conv.channel);
  if (!adapter) throw new Error(`Canal sin adapter registrado: ${conv.channel}`);
  if (!adapter.isConfigured()) {
    throw new Error(`Canal ${conv.channel} no está configurado`);
  }

  const target: OutboundTarget = {
    contactKey: conv.contact_key,
    contactRef: (conv.contact_ref ?? {}) as Record<string, unknown>,
    contactHandle: conv.contact_handle,
  };

  let providerId: string | null = null;
  let errMsg: string | null = null;
  try {
    const res = await adapter.send(target, text);
    providerId = res.id;
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
  }

  await appendMessage({
    conversation_id: conv.id,
    direction: "outbound",
    role,
    body: text,
    channel_message_id: providerId,
    status: errMsg ? "failed" : "sent",
    error: errMsg,
    ai_model: ai?.model ?? null,
    input_tokens: ai ? totalInputTokens(ai.usage) : null,
    output_tokens: ai?.usage.outputTokens ?? null,
    ai_cost_usd: ai?.cost ?? null,
    interest_level: ai?.interest ?? null,
    sent_at: errMsg ? null : new Date().toISOString(),
  });

  if (errMsg) throw new Error(errMsg);
  return providerId;
}

/**
 * Próximo `next_action_at` para un follow-up, o `null` si ya se llegó al tope.
 * `followupCount` = cuántos follow-ups ya se mandaron (0 = primera espera).
 */
function scheduleFollowup(
  followupCount: number,
  settings: AutopilotSettings,
): string | null {
  const { delaysHours, maxFollowups } = settings.followupPolicy;
  if (followupCount >= maxFollowups) return null;
  const idx = Math.min(followupCount, delaysHours.length - 1);
  const hours = delaysHours[idx] ?? 24;
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function readFollowupCount(conv: Conversation): number {
  const meta = (conv.meta ?? {}) as Record<string, unknown>;
  return typeof meta.followupCount === "number" ? meta.followupCount : 0;
}

function aiMetaFrom(out: AgentOutput): AiMeta {
  return {
    model: out.model,
    usage: out.usage,
    cost: roundCost(costUsd(out.model, out.usage)),
    interest: out.decision.interestLevel,
  };
}

function handoffAlert(
  conv: Conversation,
  lead: Lead,
  opts: { reason: string; interest: number; draftBrief: string },
): string {
  return [
    "*🤝 Handoff — un lead quiere avanzar*",
    lead.title?.trim() || "(sin título)",
    `Canal: ${conv.channel}${conv.contact_handle ? ` · ${conv.contact_handle}` : ""}`,
    `Interés: ${opts.interest}/100`,
    opts.reason ? `_${opts.reason}_` : "",
    opts.draftBrief ? `*Qué quiere:* ${opts.draftBrief}` : "",
    `Ver charla: ${env.APP_URL}/conversations/${conv.id}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─── aplicación de la decisión del agente ────────────────────────────────────

/**
 * Aplica la decisión de un turno: envía, agenda follow-up, hace handoff o
 * descarta. `replyFollowupCount` es el contador a guardar si la acción termina
 * en una respuesta/espera: `0` cuando el lead acaba de escribir (reinicia el
 * reloj), o `n+1` cuando esto es en sí un follow-up.
 */
async function applyDecision(
  conv: Conversation,
  lead: Lead,
  out: AgentOutput,
  settings: AutopilotSettings,
  replyFollowupCount: number,
): Promise<void> {
  const { decision } = out;
  const ai = aiMetaFrom(out);
  const meta = (conv.meta ?? {}) as Record<string, unknown>;

  if (decision.action === "handoff") {
    if (decision.message) {
      try {
        await sendOutbound(conv, decision.message, "agent", ai);
      } catch (err) {
        log.warn("No se pudo mandar el mensaje de cierre del handoff", {
          conversationId: conv.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await appendMessage({
      conversation_id: conv.id,
      direction: "outbound",
      role: "system",
      status: "sent",
      body: `HANDOFF: ${decision.reason}`,
    });
    await updateConversation(conv.id, {
      status: "wants_draft",
      stage: "draft_requested",
      interest_level: decision.interestLevel,
      next_action_at: null,
    });
    await notifyOwner(
      handoffAlert(conv, lead, {
        reason: decision.reason,
        interest: decision.interestLevel,
        draftBrief: decision.draftBrief,
      }),
    );
    log.info("Handoff al dueño", { conversationId: conv.id });
    return;
  }

  if (decision.action === "disqualify") {
    await appendMessage({
      conversation_id: conv.id,
      direction: "outbound",
      role: "system",
      status: "sent",
      body: `DISQUALIFY: ${decision.reason}`,
    });
    await updateConversation(conv.id, {
      status: "disqualified",
      stage: "closed",
      interest_level: decision.interestLevel,
      next_action_at: null,
    });
    log.info("Conversación descartada", { conversationId: conv.id, reason: decision.reason });
    return;
  }

  // reply o wait: ambas dejan la conversación esperando respuesta y agendan el
  // próximo follow-up. La diferencia es sólo si se manda un mensaje.
  if (decision.action === "reply" && decision.message) {
    await sendOutbound(conv, decision.message, "agent", ai);
  }
  await updateConversation(conv.id, {
    status: "awaiting_reply",
    stage: decision.stage,
    interest_level: decision.interestLevel,
    next_action_at: scheduleFollowup(replyFollowupCount, settings),
    meta: { ...meta, followupCount: replyFollowupCount },
  });
}

/** Handoff forzado por tope de mensajes (sin pasar por el agente). */
async function forceHandoff(
  conv: Conversation,
  lead: Lead,
  reason: string,
): Promise<void> {
  await appendMessage({
    conversation_id: conv.id,
    direction: "outbound",
    role: "system",
    status: "sent",
    body: `HANDOFF (forzado): ${reason}`,
  });
  await updateConversation(conv.id, {
    status: "handed_off",
    stage: "draft_requested",
    next_action_at: null,
  });
  await notifyOwner(
    handoffAlert(conv, lead, {
      reason,
      interest: conv.interest_level,
      draftBrief: conv.summary ?? "",
    }),
  );
}

// ─── turno (responder un entrante) ───────────────────────────────────────────

/**
 * Corre un turno del agente sobre una conversación: la reclama, decide y actúa.
 * Si no pudo reclamarla (hay otro turno en vuelo) sale sin hacer nada. Al
 * terminar, re-chequea si entró un mensaje nuevo durante el turno y, si sí,
 * vuelve a correr (acotado por {@link MAX_TURN_LOOP}).
 */
export async function runConversationTurn(
  conversationId: number,
  settings: AutopilotSettings,
  replyFollowupCount = 0,
  depth = 0,
): Promise<void> {
  const conv = await claimConversationForTurn(conversationId);
  if (!conv) {
    log.info("Turno en vuelo; se omite", { conversationId });
    return;
  }
  const turnStart = new Date().toISOString();

  try {
    if (!RESPONDABLE.has(conv.status)) {
      log.info("Conversación no respondible; se omite el turno", {
        conversationId,
        status: conv.status,
      });
      return;
    }

    const lead = await getLead(conv.lead_id);
    if (!lead) {
      await updateConversation(conv.id, { status: "failed", last_error: "lead inexistente" });
      return;
    }

    // Tope de mensajes del agente → handoff forzado.
    if (conv.outbound_count >= settings.agentMaxMessages) {
      await forceHandoff(
        conv,
        lead,
        "Se alcanzó el tope de mensajes del agente sin cierre; lo paso para seguimiento humano.",
      );
      return;
    }

    const messages = await recentMessages(conv.id, TRANSCRIPT_LIMIT);
    const out = await runAgent({
      mode: "reply",
      model: DEFAULT_AGENT_MODEL,
      playbook: settings.playbook,
      lead: leadContext(lead),
      channel: conv.channel,
      summary: conv.summary,
      transcript: buildTranscript(messages),
      stage: conv.stage,
      outboundCount: conv.outbound_count,
      maxMessages: settings.agentMaxMessages,
    });

    await applyDecision(conv, lead, out, settings, replyFollowupCount);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Turno falló", { conversationId, error: msg });
    await updateConversation(conv.id, { last_error: msg }).catch(() => {});
  } finally {
    await releaseConversation(conv.id).catch(() => {});
  }

  // ¿Entró algo nuevo durante el turno? Si sí, seguir (acotado).
  if (depth < MAX_TURN_LOOP) {
    const newer = await countInboundSince(conversationId, turnStart).catch(() => 0);
    if (newer > 0) {
      await runConversationTurn(conversationId, settings, 0, depth + 1);
    }
  }
}

/**
 * Procesa un mensaje entrante: lo rutea a su conversación, lo guarda
 * (deduplicado) y, si el autopilot está activo, corre un turno; si no, marca la
 * conversación para atención del dueño y le avisa.
 */
export async function ingestInbound(
  inbound: InboundMessage,
  settings: AutopilotSettings,
): Promise<{ handled: boolean; reason: string }> {
  const conv = await findConversationByContact(inbound.channel, inbound.contactKey);
  if (!conv) {
    // No tenemos una conversación con este remitente: el sistema inicia el
    // contacto, no recibe inbound a ciegas. Se ignora (se loguea).
    log.warn("Entrante sin conversación; ignorado", {
      channel: inbound.channel,
      contactKey: inbound.contactKey,
    });
    return { handled: false, reason: "sin conversación" };
  }

  const stored = await appendInboundDeduped(
    conv.id,
    inbound.text,
    inbound.providerMessageId,
  );
  if (!stored) {
    return { handled: false, reason: "duplicado" };
  }

  const autopilotOn =
    conv.autopilot &&
    settings.channelAutopilot[conv.channel] &&
    RESPONDABLE.has(conv.status);

  if (!autopilotOn) {
    // Autopilot apagado, o ya entregado/cerrado: lo atiende el dueño.
    if (RESPONDABLE.has(conv.status)) {
      await updateConversation(conv.id, { status: "awaiting_owner" });
    }
    const lead = await getLead(conv.lead_id);
    await notifyOwner(
      [
        "*💬 Mensaje nuevo (esperando que respondas vos)*",
        `${conv.contact_handle ?? "lead"} · ${conv.channel}`,
        lead?.title ? `_${lead.title}_` : "",
        `«${inbound.text.slice(0, 240)}»`,
        `Responder: ${env.APP_URL}/conversations/${conv.id}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    return { handled: true, reason: "derivado al dueño" };
  }

  // Autopilot activo: marcar 'active' y correr el turno.
  await updateConversation(conv.id, { status: "active" });
  await runConversationTurn(conv.id, settings, 0);
  return { handled: true, reason: "respondido por el agente" };
}

// ─── primer contacto (engage) ────────────────────────────────────────────────

/** Resultado de intentar enganchar un lead. */
export interface EngageResult {
  ok: boolean;
  reason: string;
  conversationId?: number;
}

/**
 * Abre una conversación con un lead y manda el primer mensaje (modo opener).
 * Idempotente: si ya existe una conversación para ese (canal, contacto), no
 * crea otra. Marca el `engage_status` del lead según el desenlace.
 */
export async function openConversationForLead(
  lead: Lead,
  settings: AutopilotSettings,
): Promise<EngageResult> {
  const channel = lead.contact_channel as Channel | null;
  const key = lead.contact_key;

  if (!channel || !key) {
    await setLeadEngageStatus(lead.id, "skipped");
    return { ok: false, reason: "lead sin canal de contacto" };
  }

  const adapter = getChannel(channel);
  if (!adapter || !adapter.isConfigured()) {
    await setLeadEngageStatus(lead.id, "skipped");
    return { ok: false, reason: `canal ${channel} no configurado` };
  }

  // ¿Ya hay una conversación con este contacto? (idempotencia / carrera).
  const existing = await findConversationByContact(channel, key);
  if (existing) {
    await setLeadEngageStatus(lead.id, "engaged");
    return { ok: true, reason: "ya existía una conversación", conversationId: existing.id };
  }

  let conv: Conversation;
  try {
    conv = await createConversation({
      lead_id: lead.id,
      channel,
      contact_key: key,
      contact_ref: (lead.contact_ref ?? {}) as Record<string, unknown>,
      contact_handle: lead.contact_handle,
      autopilot: settings.channelAutopilot[channel] ?? true,
    });
  } catch {
    const again = await findConversationByContact(channel, key);
    if (again) {
      await setLeadEngageStatus(lead.id, "engaged");
      return { ok: true, reason: "carrera: ya existía", conversationId: again.id };
    }
    await setLeadEngageStatus(lead.id, "pending");
    return { ok: false, reason: "no se pudo crear la conversación" };
  }

  try {
    const out = await runAgent({
      mode: "opener",
      model: DEFAULT_AGENT_MODEL,
      playbook: settings.playbook,
      lead: leadContext(lead),
      channel,
      transcript: [],
      stage: "outreach",
      outboundCount: 0,
      maxMessages: settings.agentMaxMessages,
    });
    const text =
      out.decision.message ||
      lead.suggested_reply ||
      "¡Hola! Vi tu publicación. ¿Seguís buscando a alguien para el proyecto?";

    await sendOutbound(conv, text, "agent", aiMetaFrom(out));
    await updateConversation(conv.id, {
      status: "awaiting_reply",
      stage: "greeted",
      interest_level: out.decision.interestLevel,
      next_action_at: scheduleFollowup(0, settings),
      meta: { followupCount: 0 },
    });
    await setLeadEngageStatus(lead.id, "engaged");
    return { ok: true, reason: "enganchado", conversationId: conv.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateConversation(conv.id, { status: "failed", last_error: msg });
    // Devolvemos el lead a la cola: el claim resiliente lo re-toma más tarde.
    await setLeadEngageStatus(lead.id, "pending");
    log.error("Falló el primer contacto", { leadId: lead.id, error: msg });
    return { ok: false, reason: `falló el envío: ${msg}` };
  }
}

/**
 * Manda un mensaje escrito a mano por el dueño desde el panel. Lo envía por el
 * canal de la conversación con `role='owner'` y deja la charla esperando
 * respuesta (sin follow-up automático: a partir de acá la maneja el dueño).
 * Sirve para retomar una conversación o responder con el autopilot apagado.
 */
export async function sendOwnerMessage(
  conversationId: number,
  text: string,
): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error(`Conversación inexistente: ${conversationId}`);
  await sendOutbound(conv, text, "owner");
  await updateConversation(conv.id, {
    status: "awaiting_reply",
    next_action_at: null,
  });
}

// ─── follow-up (reenganche programado) ───────────────────────────────────────

/**
 * Reengancha una conversación que se enfrió. La conversación ya viene reclamada
 * por `claim_conversations_due`; esta función libera el claim al terminar.
 */
export async function runConversationFollowup(
  conv: Conversation,
  settings: AutopilotSettings,
): Promise<void> {
  try {
    const followupCount = readFollowupCount(conv);

    // Autopilot del canal/conversación apagado → no reenganchar.
    if (!conv.autopilot || !settings.channelAutopilot[conv.channel]) {
      await updateConversation(conv.id, { next_action_at: null });
      return;
    }
    // Se agotaron los follow-ups → marcar perdido.
    if (followupCount >= settings.followupPolicy.maxFollowups) {
      await updateConversation(conv.id, {
        status: "lost",
        stage: "closed",
        next_action_at: null,
      });
      return;
    }

    const lead = await getLead(conv.lead_id);
    if (!lead) {
      await updateConversation(conv.id, { next_action_at: null });
      return;
    }

    const messages = await recentMessages(conv.id, TRANSCRIPT_LIMIT);
    const transcript = buildTranscript(messages);
    transcript.push({
      role: "system",
      text: "El lead no respondió desde tu último mensaje. Escribí un follow-up corto y amable para reenganchar, sin presionar ni repetir lo mismo.",
    });

    const out = await runAgent({
      mode: "reply",
      model: DEFAULT_AGENT_MODEL,
      playbook: settings.playbook,
      lead: leadContext(lead),
      channel: conv.channel,
      summary: conv.summary,
      transcript,
      stage: conv.stage,
      outboundCount: conv.outbound_count,
      maxMessages: settings.agentMaxMessages,
    });

    // El nuevo follow-up incrementa el contador; handoff/disqualify se respetan.
    await applyDecision(conv, lead, out, settings, followupCount + 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Follow-up falló", { conversationId: conv.id, error: msg });
    await updateConversation(conv.id, { last_error: msg, next_action_at: null }).catch(() => {});
  } finally {
    await releaseConversation(conv.id).catch(() => {});
  }
}

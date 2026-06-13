"use server";

/**
 * Server actions de la sección de Conversaciones del command-center.
 *
 * Igual que el resto de las acciones del dashboard (`leads/[id]/actions.ts`,
 * `config/actions.ts`), el acceso lo protege `proxy.ts` a nivel de ruta: este
 * grupo `(dashboard)` no es alcanzable sin una cookie `ld_session` firmada y
 * vigente, así que las acciones no repiten esa verificación. Sí validan sus
 * inputs (ids positivos, estados permitidos) antes de tocar la base, y revalidan
 * las rutas afectadas para que el cambio se vea al instante.
 */

import { revalidatePath } from "next/cache";

import { sendOwnerMessage } from "@/lib/conversation/engine";
import { updateConversation } from "@/lib/db/conversations";
import type { ConversationStatus } from "@/types/autopilot";

/** Resultado de una acción sobre una conversación: éxito o el motivo del fallo. */
export interface ConversationActionResult {
  ok: boolean;
  error?: string;
}

/** Estados a los que el dueño puede mover una conversación a mano desde el panel. */
const SETTABLE_STATUSES = [
  "won",
  "lost",
  "paused",
  "awaiting_reply",
] as const satisfies readonly ConversationStatus[];

type SettableStatus = (typeof SETTABLE_STATUSES)[number];

/** `true` si `id` es un id real de la tabla (entero positivo). */
function isValidId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/** Revalida las dos vistas que muestran el estado de una conversación. */
function revalidateConversation(id: number): void {
  revalidatePath("/conversations");
  revalidatePath(`/conversations/${id}`);
  // El Resumen agrega contadores de conversaciones: también se desactualiza.
  revalidatePath("/overview");
}

/**
 * Activa o desactiva el autopilot de una conversación.
 *
 * Con el autopilot en `off`, el agente deja de responder solo: los entrantes
 * pasan a "te toca responder". Volver a `on` reanuda la respuesta automática.
 */
export async function setAutopilot(
  conversationId: number,
  on: boolean,
): Promise<ConversationActionResult> {
  if (!isValidId(conversationId)) {
    return { ok: false, error: "Conversación inválida." };
  }
  try {
    await updateConversation(conversationId, { autopilot: on });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No se pudo cambiar el autopilot: ${msg}` };
  }
  revalidateConversation(conversationId);
  return { ok: true };
}

/**
 * Manda un mensaje escrito a mano por el dueño en una conversación.
 *
 * Lo envía por el canal de la charla (`role='owner'`) y la deja esperando
 * respuesta, sin follow-up automático: a partir de acá la conduce el dueño.
 */
export async function sendOwnerReply(
  conversationId: number,
  text: string,
): Promise<ConversationActionResult> {
  if (!isValidId(conversationId)) {
    return { ok: false, error: "Conversación inválida." };
  }
  const body = text.trim();
  if (!body) {
    return { ok: false, error: "El mensaje no puede estar vacío." };
  }
  if (body.length > 4000) {
    return { ok: false, error: "El mensaje es demasiado largo (máx. 4000)." };
  }
  try {
    await sendOwnerMessage(conversationId, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No se pudo enviar el mensaje: ${msg}` };
  }
  revalidateConversation(conversationId);
  return { ok: true };
}

/**
 * Cambia el estado de una conversación a uno de los permitidos a mano:
 * `won` (ganado), `lost` (perdido), `paused` (pausada) o `awaiting_reply`
 * (reanudada, esperando respuesta). Al pausar/reanudar se corta cualquier
 * follow-up pendiente.
 */
export async function setConversationStatus(
  conversationId: number,
  status: SettableStatus,
): Promise<ConversationActionResult> {
  if (!isValidId(conversationId)) {
    return { ok: false, error: "Conversación inválida." };
  }
  if (!SETTABLE_STATUSES.includes(status)) {
    return { ok: false, error: "Estado inválido." };
  }
  try {
    // Al cerrar (won/lost) o pausar, no debe quedar un follow-up agendado.
    await updateConversation(conversationId, {
      status,
      next_action_at: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `No se pudo cambiar el estado: ${msg}` };
  }
  revalidateConversation(conversationId);
  return { ok: true };
}

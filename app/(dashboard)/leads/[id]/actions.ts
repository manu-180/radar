"use server";

/**
 * Server actions del detalle de lead.
 *
 * El feedback que se guarda acá no es cosmético: el clasificador (paso 15) lo
 * lee como ejemplos dinámicos para calibrarse. Por eso se persiste siempre con
 * `feedback_at`, que es el timestamp por el que el clasificador ordena y elige
 * los ejemplos más recientes.
 */

import { revalidatePath } from "next/cache";

import { getAdminClient } from "@/lib/supabase/admin";

/** Valores de feedback permitidos, alineados con el `check` de `leads.feedback`. */
const FEEDBACK_VALUES = ["responded", "interested", "not_relevant"] as const;

/** Un valor de feedback válido para un lead. */
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number];

/** Resultado de aplicar feedback: éxito, o el motivo del fallo. */
export interface FeedbackResult {
  ok: boolean;
  error?: string;
}

/**
 * Marca el feedback de un lead.
 *
 * Setea `leads.feedback` y `leads.feedback_at`, y revalida el detalle para que
 * la página refleje el cambio sin recargar manualmente.
 *
 * @param leadId   ID del lead a marcar.
 * @param feedback Valor de feedback; se valida contra los permitidos.
 */
export async function setLeadFeedback(
  leadId: number,
  feedback: FeedbackValue,
): Promise<FeedbackResult> {
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return { ok: false, error: "Lead inválido." };
  }
  if (!FEEDBACK_VALUES.includes(feedback)) {
    return { ok: false, error: "Feedback inválido." };
  }

  const db = getAdminClient();
  const { error } = await db
    .from("leads")
    .update({ feedback, feedback_at: new Date().toISOString() })
    .eq("id", leadId);

  if (error) {
    return { ok: false, error: `No se pudo guardar el feedback: ${error.message}` };
  }

  revalidatePath(`/leads/${leadId}`);
  return { ok: true };
}

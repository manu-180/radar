"use server";

/**
 * Server actions de las pestañas **Playbook** y **Autopilot** del panel de
 * Configuración.
 *
 * Mismo patrón que `config/source-actions.ts`: el acceso lo protege `proxy.ts` a
 * nivel de ruta, así que estas acciones no repiten la verificación de sesión.
 * Cada una valida su payload (con los schemas de `lib/settings.ts` donde aplica),
 * lo persiste en `settings` vía upsert y revalida `/config`. Como el motor
 * (`/api/engage`, `/api/inbound/*`, `/api/followup`) relee `settings` en cada
 * corrida, el cambio impacta en la próxima sin redeploy.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type { Channel } from "@/types/autopilot";
import { notifyRuleSchema } from "@/lib/settings";
import { getAdminClient } from "@/lib/supabase/admin";

/** Resultado de una acción de configuración: éxito, o el motivo del fallo. */
export interface ConfigResult {
  ok: boolean;
  error?: string;
}

/** Topes defensivos para evitar valores absurdos en `settings`. */
const MAX_DAILY_CAP = 1000;
const MAX_AGENT_MESSAGES = 100;
const MAX_FOLLOWUPS = 20;
const MAX_PLAYBOOK_FIELD = 4000;

/** Aplana un `ZodError` en un mensaje legible. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join(" · ");
}

/** Persiste un valor en `settings`, refrescando `updated_at`. */
async function writeSetting(key: string, value: unknown): Promise<ConfigResult> {
  const { error } = await getAdminClient()
    .from("settings")
    .upsert(
      { key, value, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) {
    return {
      ok: false,
      error: `No se pudo guardar el ajuste "${key}": ${error.message}`,
    };
  }
  revalidatePath("/config");
  return { ok: true };
}

// ─── Playbook ────────────────────────────────────────────────────────────────

/** Forma del playbook tal como llega del formulario. */
export interface PlaybookInput {
  persona: string;
  offer: string;
  pricing: string;
  tone: string;
  goal: string;
  handoff_triggers: string;
}

const playbookField = z
  .string()
  .trim()
  .min(1, "no puede estar vacío")
  .max(MAX_PLAYBOOK_FIELD, `no puede superar ${MAX_PLAYBOOK_FIELD} caracteres`);

const playbookInputSchema = z.object({
  persona: playbookField,
  offer: playbookField,
  pricing: playbookField,
  tone: playbookField,
  goal: playbookField,
  handoff_triggers: playbookField,
});

/**
 * Guarda el playbook del closer (`settings.agent_playbook`).
 *
 * Es el guion que define quién es el agente, qué ofrece, a qué precios y cuándo
 * derivar el lead. Todos los campos son obligatorios: van horneados en el system
 * prompt cacheado del agente.
 */
export async function updatePlaybook(
  input: PlaybookInput,
): Promise<ConfigResult> {
  const parsed = playbookInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `El playbook no es válido: ${formatZodError(parsed.error)}`,
    };
  }
  return writeSetting("agent_playbook", parsed.data);
}

// ─── Autopilot ───────────────────────────────────────────────────────────────

/**
 * Enciende o apaga el interruptor maestro de outreach (`settings.outreach_enabled`).
 *
 * Es el kill-switch: con esto en `true`, el sistema contacta gente de forma
 * automática. En `false`, no se inicia ningún primer contacto.
 */
export async function setOutreachEnabled(on: boolean): Promise<ConfigResult> {
  return writeSetting("outreach_enabled", on === true);
}

/** Forma del bloque de autopilot que llega del formulario. */
export interface AutopilotInput {
  channelAutopilot: Record<Channel, boolean>;
  engageRule: { categories: string[]; minScore: number };
  outreachDailyCap: number;
  agentMaxMessages: number;
  followupPolicy: { delaysHours: number[]; maxFollowups: number };
}

const channelAutopilotSchema = z.object({
  telegram: z.boolean(),
  bluesky: z.boolean(),
  whatsapp: z.boolean(),
  reddit: z.boolean(),
});

const followupPolicySchema = z.object({
  delaysHours: z
    .array(z.number().min(0, "las esperas no pueden ser negativas"))
    .min(1, "tiene que haber al menos una espera")
    .max(MAX_FOLLOWUPS, "demasiadas esperas"),
  maxFollowups: z
    .number()
    .int("tiene que ser un entero")
    .min(0)
    .max(MAX_FOLLOWUPS, `no puede superar ${MAX_FOLLOWUPS}`),
});

const autopilotInputSchema = z.object({
  channelAutopilot: channelAutopilotSchema,
  engageRule: notifyRuleSchema,
  outreachDailyCap: z
    .number()
    .int("tiene que ser un entero")
    .min(1, "tiene que ser al menos 1")
    .max(MAX_DAILY_CAP, `no puede superar ${MAX_DAILY_CAP}`),
  agentMaxMessages: z
    .number()
    .int("tiene que ser un entero")
    .min(1, "tiene que ser al menos 1")
    .max(MAX_AGENT_MESSAGES, `no puede superar ${MAX_AGENT_MESSAGES}`),
  followupPolicy: followupPolicySchema,
});

/**
 * Guarda toda la config del autopilot de una vez (salvo el kill-switch maestro,
 * que tiene su propia acción para poder togglearse sin tocar el resto):
 * autopilot por canal, regla de enganche, tope diario, tope de mensajes del
 * agente y política de follow-ups. Cada bloque va a su propia clave de `settings`.
 */
export async function updateAutopilot(
  input: AutopilotInput,
): Promise<ConfigResult> {
  const parsed = autopilotInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: `La configuración no es válida: ${formatZodError(parsed.error)}`,
    };
  }
  const data = parsed.data;

  // Se persiste clave por clave; el primer error corta y se reporta.
  const writes: [string, unknown][] = [
    ["channel_autopilot", data.channelAutopilot],
    ["engage_rule", data.engageRule],
    ["outreach_daily_cap", data.outreachDailyCap],
    ["agent_max_messages", data.agentMaxMessages],
    ["followup_policy", data.followupPolicy],
  ];

  for (const [key, value] of writes) {
    const result = await writeSetting(key, value);
    if (!result.ok) return result;
  }
  return { ok: true };
}

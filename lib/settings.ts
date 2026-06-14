/**
 * Carga tipada y unificada de la tabla `settings`.
 *
 * `settings` es la config del detector manejada por datos: la regla de
 * notificación, el tope de avisos por corrida, el perfil del freelancer y
 * cuántos ejemplos de feedback usar. Antes, `/api/process` y `/api/notify`
 * **duplicaban** la interfaz `NotifyRule`, sus defaults y la lógica de parseo —
 * dos definiciones que podían quedar desincronizadas.
 *
 * Este módulo es la **única fuente de verdad**: define el esquema, los valores
 * por defecto y las funciones de carga que ambas rutas (y el panel) comparten.
 * Cada función relee la tabla en cada corrida, así un cambio desde el dashboard
 * impacta en la corrida siguiente sin redeploy.
 */

import "server-only";

import { z } from "zod";

import type { AgentPlaybook } from "@/lib/ai/agent";
import { getAdminClient } from "@/lib/supabase/admin";
import { CHANNELS, type Channel } from "@/types/autopilot";

/** Categorías de lead válidas; alineadas con el `check` de `leads.category`. */
export const LEAD_CATEGORIES = ["hiring", "maybe", "noise"] as const;

/**
 * Esquema de `settings.notify_rule`: qué categorías y qué score mínimo ameritan
 * un aviso por WhatsApp. Es el contrato único contra el que se valida la regla,
 * tanto al leerla (process/notify) como al guardarla desde el panel.
 */
export const notifyRuleSchema = z.object({
  /** Categorías de lead que disparan un aviso; al menos una. */
  categories: z.array(z.enum(LEAD_CATEGORIES)).min(1),
  /** Score mínimo (0–100) para avisar dentro de esas categorías. */
  minScore: z.number().int().min(0).max(100),
});

/** Regla de notificación ya validada. */
export type NotifyRule = z.infer<typeof notifyRuleSchema>;

/** Regla de notificación por defecto si la clave falta o es inválida. */
export const DEFAULT_NOTIFY_RULE: NotifyRule = {
  categories: ["hiring"],
  minScore: 70,
};
/** Tope de avisos por corrida por defecto. */
export const DEFAULT_MAX_NOTIFICATIONS_PER_RUN = 10;
/** Cantidad de ejemplos de feedback por defecto. */
export const DEFAULT_FEEDBACK_EXAMPLES_COUNT = 6;

/** Claves de `settings` que el procesamiento necesita. */
const PROCESS_KEYS = [
  "freelancer_profile",
  "notify_rule",
  "feedback_examples_count",
] as const;

/** Claves de `settings` que la notificación necesita. */
const NOTIFY_KEYS = ["notify_rule", "max_notifications_per_run"] as const;

/** Lee un conjunto de claves de `settings` y las indexa por clave. */
async function readSettings(
  keys: readonly string[],
): Promise<Map<string, unknown>> {
  const { data, error } = await getAdminClient()
    .from("settings")
    .select("key, value")
    .in("key", keys as string[]);

  if (error) {
    throw new Error(`No se pudieron leer los settings: ${error.message}`);
  }

  return new Map<string, unknown>(
    (data ?? []).map((row) => [row.key as string, row.value]),
  );
}

/** Valida un valor crudo contra {@link notifyRuleSchema}; cae al default si no pasa. */
function parseNotifyRule(raw: unknown): NotifyRule {
  const parsed = notifyRuleSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_NOTIFY_RULE;
}

/**
 * Coacciona un valor crudo a un entero positivo; cae a `fallback` si no es un
 * número válido (`> 0`). Los flotantes se truncan hacia abajo.
 */
function parsePositiveInt(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : fallback;
}

/** Config que necesita `/api/process` para clasificar un lote. */
export interface ProcessSettings {
  /** Perfil del freelancer (`freelancer_profile`); `""` si falta. */
  freelancerProfile: string;
  /** Regla de notificación efectiva. */
  notifyRule: NotifyRule;
  /** Cuántos ejemplos de feedback inyectar al clasificador. */
  feedbackExamplesCount: number;
}

/** Carga las claves de `settings` que usa el procesamiento de leads. */
export async function loadProcessSettings(): Promise<ProcessSettings> {
  const byKey = await readSettings(PROCESS_KEYS);

  const profileRaw = byKey.get("freelancer_profile");
  const freelancerProfile =
    typeof profileRaw === "string" ? profileRaw : "";

  const countRaw = byKey.get("feedback_examples_count");
  // El conteo admite 0 (desactivar feedback), así que no usa `parsePositiveInt`.
  const feedbackExamplesCount =
    typeof countRaw === "number" && Number.isFinite(countRaw) && countRaw >= 0
      ? Math.floor(countRaw)
      : DEFAULT_FEEDBACK_EXAMPLES_COUNT;

  return {
    freelancerProfile,
    notifyRule: parseNotifyRule(byKey.get("notify_rule")),
    feedbackExamplesCount,
  };
}

/** Config que necesita `/api/notify` para avisar un lote. */
export interface NotifySettings {
  /** Regla de notificación efectiva. */
  notifyRule: NotifyRule;
  /** Tope de avisos que pueden salir en una sola corrida. */
  maxNotificationsPerRun: number;
}

/** Carga las claves de `settings` que usa la notificación de leads. */
export async function loadNotifySettings(): Promise<NotifySettings> {
  const byKey = await readSettings(NOTIFY_KEYS);

  return {
    notifyRule: parseNotifyRule(byKey.get("notify_rule")),
    maxNotificationsPerRun: parsePositiveInt(
      byKey.get("max_notifications_per_run"),
      DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
    ),
  };
}

// ─── Autopilot (v2) ──────────────────────────────────────────────────────────

/** Playbook por defecto del closer si la clave falta o es inválida. */
export const DEFAULT_PLAYBOOK: AgentPlaybook = {
  persona:
    "Sos un desarrollador freelance argentino, cercano y profesional. Hablás en español rioplatense, claro y sin vueltas, sin sonar a bot ni a vendedor agresivo.",
  offer:
    "Hacés páginas web y apps a medida con Next.js, React y back-ends modernos (Supabase). Entrega rápida, diseño prolijo y precios competitivos.",
  pricing:
    "Una landing simple arranca en USD 150-300; un sitio con varias secciones USD 300-700; una web app a medida se cotiza según alcance.",
  tone:
    "Cálido, directo, humano. Mensajes cortos de WhatsApp/DM. Una idea por mensaje. Una sola pregunta por vez.",
  goal:
    "Entender qué necesita, generar confianza y llevarlo a que pida una propuesta o un boceto. Cuando lo pida, handoff al dueño.",
  handoff_triggers:
    "pide un boceto o mockup, pide una propuesta o presupuesto formal, quiere agendar una llamada, pide hablar con la persona, o ya hay acuerdo de avanzar.",
};

export const DEFAULT_ENGAGE_RULE: NotifyRule = {
  categories: ["hiring"],
  minScore: 75,
};
export const DEFAULT_CHANNEL_AUTOPILOT: Record<Channel, boolean> = {
  telegram: true,
  bluesky: true,
  whatsapp: true,
  reddit: false,
};
export const DEFAULT_OUTREACH_DAILY_CAP = 20;
export const DEFAULT_AGENT_MAX_MESSAGES = 12;
export const DEFAULT_FOLLOWUP_POLICY = { delaysHours: [24, 72], maxFollowups: 2 };

/** Política de reenganche: esperas entre follow-ups y cuántos como máximo. */
export interface FollowupPolicy {
  delaysHours: number[];
  maxFollowups: number;
}

const playbookSchema = z
  .object({
    persona: z.string().min(1),
    offer: z.string().min(1),
    pricing: z.string().min(1),
    tone: z.string().min(1),
    goal: z.string().min(1),
    handoff_triggers: z.string().min(1),
  })
  .partial();

const channelAutopilotSchema = z
  .object({
    telegram: z.boolean(),
    bluesky: z.boolean(),
    whatsapp: z.boolean(),
    reddit: z.boolean(),
  })
  .partial();

const followupPolicySchema = z.object({
  delaysHours: z.array(z.number().min(0)).min(1),
  maxFollowups: z.number().int().min(0),
});

const AUTOPILOT_KEYS = [
  "outreach_enabled",
  "engage_rule",
  "channel_autopilot",
  "outreach_daily_cap",
  "agent_max_messages",
  "followup_policy",
  "agent_playbook",
] as const;

/** Config completa del autopilot, ya validada y con defaults aplicados. */
export interface AutopilotSettings {
  /** Interruptor maestro: si está en `false`, no se contacta a nadie. */
  outreachEnabled: boolean;
  /** Regla de elegibilidad para el primer contacto. */
  engageRule: NotifyRule;
  /** Autopilot por canal: si un canal está en `false`, no responde solo. */
  channelAutopilot: Record<Channel, boolean>;
  /** Tope de primeros contactos por día (anti-ban). */
  outreachDailyCap: number;
  /** Tope de mensajes del agente antes de un handoff forzado. */
  agentMaxMessages: number;
  /** Política de reenganche. */
  followupPolicy: FollowupPolicy;
  /** Playbook del closer. */
  playbook: AgentPlaybook;
}

export function parsePlaybook(raw: unknown): AgentPlaybook {
  const parsed = playbookSchema.safeParse(raw);
  if (!parsed.success) return DEFAULT_PLAYBOOK;
  // Mezcla los campos provistos sobre el default (el panel puede guardar parcial).
  return { ...DEFAULT_PLAYBOOK, ...parsed.data };
}

export function parseChannelAutopilot(raw: unknown): Record<Channel, boolean> {
  const parsed = channelAutopilotSchema.safeParse(raw);
  const base = { ...DEFAULT_CHANNEL_AUTOPILOT };
  if (parsed.success) {
    for (const ch of CHANNELS) {
      const v = parsed.data[ch];
      if (typeof v === "boolean") base[ch] = v;
    }
  }
  return base;
}

export function parseFollowupPolicy(raw: unknown): FollowupPolicy {
  const parsed = followupPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_FOLLOWUP_POLICY;
}

/** Carga toda la config del autopilot. Relee la tabla en cada corrida. */
export async function loadAutopilotSettings(): Promise<AutopilotSettings> {
  const byKey = await readSettings(AUTOPILOT_KEYS);

  const engageRaw = notifyRuleSchema.safeParse(byKey.get("engage_rule"));
  return {
    outreachEnabled: byKey.get("outreach_enabled") === true,
    // `engage_rule` comparte la forma de `notify_rule`, pero su default propio.
    engageRule: engageRaw.success ? engageRaw.data : DEFAULT_ENGAGE_RULE,
    channelAutopilot: parseChannelAutopilot(byKey.get("channel_autopilot")),
    outreachDailyCap: parsePositiveInt(
      byKey.get("outreach_daily_cap"),
      DEFAULT_OUTREACH_DAILY_CAP,
    ),
    agentMaxMessages: parsePositiveInt(
      byKey.get("agent_max_messages"),
      DEFAULT_AGENT_MAX_MESSAGES,
    ),
    followupPolicy: parseFollowupPolicy(byKey.get("followup_policy")),
    playbook: parsePlaybook(byKey.get("agent_playbook")),
  };
}

// ─── Tope de costo de la IA (Capa 4) ─────────────────────────────────────────

/** Tope de gasto por defecto del clasificador, en USD. */
export const DEFAULT_CLASSIFIER_BUDGET_USD = 5;

const CLASSIFIER_BUDGET_KEYS = [
  "classifier_budget_usd",
  "classifier_spend_baseline_usd",
  "classifier_paused",
] as const;

/** Estado del presupuesto del clasificador, ya validado y con defaults. */
export interface ClassifierBudget {
  /**
   * Tope de gasto en USD. `null` = ilimitado (clave ausente o `<= 0`), para
   * cuando se quiera "dejarlo libre".
   */
  budgetUsd: number | null;
  /**
   * Gasto acumulado (USD) registrado al activar el tope. El gasto efectivo que
   * cuenta contra el budget es `SUM(llm_cost_usd de los done) - baseline`.
   */
  spendBaselineUsd: number;
  /** Kill-switch: si está en `true`, la clasificación está pausada. */
  paused: boolean;
}

/** Coacciona un valor crudo a un número finito `>= 0`; cae a `fallback` si no. */
function parseNonNegativeNumber(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : fallback;
}

/**
 * Carga el estado del presupuesto del clasificador. Relee la tabla en cada
 * corrida, así un cambio desde `/config` (subir el tope, despausar) impacta en
 * la corrida siguiente sin redeploy.
 */
export async function loadClassifierBudget(): Promise<ClassifierBudget> {
  const byKey = await readSettings(CLASSIFIER_BUDGET_KEYS);

  const budgetRaw = byKey.get("classifier_budget_usd");
  // Si la clave existe y es un número: `> 0` es el tope, `<= 0` = ilimitado
  // (opt-out explícito). Si falta o es inválida, cae al tope por defecto: el cap
  // es el default SEGURO, no "ilimitado" — así un olvido no deja la IA sin freno.
  let budgetUsd: number | null;
  if (typeof budgetRaw === "number" && Number.isFinite(budgetRaw)) {
    budgetUsd = budgetRaw > 0 ? budgetRaw : null;
  } else {
    budgetUsd = DEFAULT_CLASSIFIER_BUDGET_USD;
  }

  return {
    budgetUsd,
    spendBaselineUsd: parseNonNegativeNumber(
      byKey.get("classifier_spend_baseline_usd"),
      0,
    ),
    paused: byKey.get("classifier_paused") === true,
  };
}

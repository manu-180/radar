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

import { getAdminClient } from "@/lib/supabase/admin";

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

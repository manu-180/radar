"use server";

/**
 * Server actions de las secciones de **fuentes** y **ajustes generales** del
 * panel de Configuración.
 *
 * Estas acciones cierran el círculo del detector "manejado por datos": activar
 * una fuente, reescribir su `config` o ajustar las reglas generales se hace
 * desde la web, sin tocar código ni redeployar. Cada acción revalida `/config`
 * para reflejar el cambio al instante; como el polling, el procesamiento y la
 * notificación releen `sources`/`settings` en cada corrida, el cambio impacta
 * en la próxima.
 *
 * El `config` de una fuente se valida contra el `configSchema` real del
 * adaptador (vía el registry) antes de persistirse: así un valor inválido se
 * rechaza acá y nunca llega a romper una corrida de polling.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getSource } from "@/lib/sources";
import { getAdminClient } from "@/lib/supabase/admin";

/** Categorías de lead válidas, alineadas con el `check` de `leads.category`. */
const CATEGORIES = ["hiring", "maybe", "noise"] as const;

/** Tope defensivo de avisos por corrida; evita valores absurdos en `settings`. */
const MAX_NOTIFICATIONS_CAP = 1000;

/** Largo máximo del perfil del freelancer; la tabla no lo acota, lo hacemos acá. */
const MAX_PROFILE_LENGTH = 2000;

/** Resultado de una acción de configuración: éxito, o el motivo del fallo. */
export interface ConfigResult {
  ok: boolean;
  error?: string;
}

/** Aplana un `ZodError` en un mensaje legible, una línea por problema. */
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(" · ");
}

/** Parsea texto a JSON; devuelve el valor, o un string con el motivo del fallo. */
function parseJson(text: string): { value: unknown } | string {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `El texto no es JSON válido: ${detail}`;
  }
}

/**
 * Activa o desactiva una fuente sin borrarla.
 *
 * Una fuente desactivada queda en la tabla pero el polling la saltea, así que
 * sirve para pausarla sin perder su `config` ni su `cursor`.
 */
export async function toggleSource(
  slug: string,
  enabled: boolean,
): Promise<ConfigResult> {
  const { error } = await getAdminClient()
    .from("sources")
    .update({ enabled })
    .eq("slug", slug);
  if (error) {
    return {
      ok: false,
      error: `No se pudo cambiar el estado de la fuente: ${error.message}`,
    };
  }

  revalidatePath("/config");
  return { ok: true };
}

/**
 * Reescribe el `config` de una fuente desde el editor de texto JSON.
 *
 * El texto se parsea como JSON y, si la fuente tiene un adaptador registrado,
 * se valida contra su `configSchema` de Zod. Sólo el valor ya validado (con los
 * defaults del schema aplicados) se persiste. Una fuente sin adaptador —p. ej.
 * `telegram`/`discord` aún sin implementar— se guarda como objeto JSON tal cual,
 * ya que no hay schema contra el cual validarla.
 */
export async function updateSourceConfig(
  slug: string,
  configText: string,
): Promise<ConfigResult> {
  const parsed = parseJson(configText);
  if (typeof parsed === "string") return { ok: false, error: parsed };

  let config: unknown;
  const adapter = getSource(slug);
  if (adapter) {
    const result = adapter.configSchema.safeParse(parsed.value);
    if (!result.success) {
      return {
        ok: false,
        error: `El config no pasa la validación de la fuente: ${formatZodError(result.error)}`,
      };
    }
    config = result.data;
  } else {
    // Sin adaptador no hay `configSchema`: sólo exigimos que sea un objeto JSON.
    if (
      typeof parsed.value !== "object" ||
      parsed.value === null ||
      Array.isArray(parsed.value)
    ) {
      return { ok: false, error: "El config debe ser un objeto JSON." };
    }
    config = parsed.value;
  }

  const { error } = await getAdminClient()
    .from("sources")
    .update({ config })
    .eq("slug", slug);
  if (error) {
    return {
      ok: false,
      error: `No se pudo guardar el config: ${error.message}`,
    };
  }

  revalidatePath("/config");
  return { ok: true };
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

/** Schema de `settings.notify_rule`: qué categorías y qué score ameritan avisar. */
const notifyRuleSchema = z.object({
  /** Categorías de lead que disparan un aviso; al menos una. */
  categories: z.array(z.enum(CATEGORIES)).min(1),
  /** Score mínimo (0–100) para avisar dentro de esas categorías. */
  minScore: z.number().int().min(0).max(100),
});

/**
 * Edita la regla de notificación (`settings.notify_rule`) desde el editor JSON.
 *
 * El texto se valida contra {@link notifyRuleSchema}: categorías conocidas y un
 * `minScore` entero entre 0 y 100. Un JSON inválido o fuera de esquema se
 * rechaza sin tocar `settings`.
 */
export async function updateNotifyRule(
  ruleText: string,
): Promise<ConfigResult> {
  const parsed = parseJson(ruleText);
  if (typeof parsed === "string") return { ok: false, error: parsed };

  const result = notifyRuleSchema.safeParse(parsed.value);
  if (!result.success) {
    return {
      ok: false,
      error: `La regla no es válida: ${formatZodError(result.error)}`,
    };
  }

  return writeSetting("notify_rule", result.data);
}

/** Edita el tope de avisos por corrida (`settings.max_notifications_per_run`). */
export async function updateMaxNotifications(
  value: number,
): Promise<ConfigResult> {
  if (!Number.isInteger(value) || value < 1 || value > MAX_NOTIFICATIONS_CAP) {
    return {
      ok: false,
      error: `Debe ser un entero entre 1 y ${MAX_NOTIFICATIONS_CAP}.`,
    };
  }

  return writeSetting("max_notifications_per_run", value);
}

/**
 * Edita el perfil del freelancer (`settings.freelancer_profile`).
 *
 * Es la bio que la IA usa para personalizar las respuestas sugeridas, así que
 * no puede quedar vacía.
 */
export async function updateFreelancerProfile(
  profile: string,
): Promise<ConfigResult> {
  const trimmed = profile.trim();
  if (!trimmed) {
    return { ok: false, error: "El perfil no puede estar vacío." };
  }
  if (trimmed.length > MAX_PROFILE_LENGTH) {
    return {
      ok: false,
      error: `El perfil no puede superar los ${MAX_PROFILE_LENGTH} caracteres.`,
    };
  }

  return writeSetting("freelancer_profile", trimmed);
}

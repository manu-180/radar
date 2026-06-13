/**
 * Registro de corridas en la tabla `runs`.
 *
 * Cada job del sistema (polling, procesamiento, notificación, health-check)
 * abre una fila con {@link startRun} al empezar y la cierra con
 * {@link finishRun} al terminar. La tabla `runs` es la base de la
 * observabilidad: permite saber qué se ejecutó, cuándo y con qué resultado.
 */

import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";

/** Tipo de job que origina la corrida; coincide con el `check` de `runs.kind`. */
export type RunKind =
  | "poll"
  | "process"
  | "notify"
  | "health"
  | "engage"
  | "followup"
  | "inbound";

/** Estado final de una corrida ya terminada. */
export type RunFinalStatus = "ok" | "error";

/** Datos con los que se cierra una corrida. */
export interface FinishRunOptions {
  /** Resultado final: `ok` si completó, `error` si falló. */
  status: RunFinalStatus;
  /** Items encontrados por la corrida. */
  itemsFound?: number;
  /** Items nuevos (no vistos antes). */
  itemsNew?: number;
  /** Items efectivamente procesados. */
  itemsProcessed?: number;
  /** Mensaje de error, si la corrida falló. */
  error?: string | null;
}

/**
 * Abre una corrida: inserta una fila en `runs` con `status = 'running'`.
 *
 * @param kind    Tipo de job que arranca.
 * @param source  Slug de la fuente involucrada, si aplica (ej. en un `poll`).
 * @returns El `id` de la fila creada, para cerrarla luego con {@link finishRun}.
 */
export async function startRun(kind: RunKind, source?: string): Promise<number> {
  const { data, error } = await getAdminClient()
    .from("runs")
    .insert({ kind, source: source ?? null, status: "running" })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(
      `startRun: no se pudo crear la corrida (${kind}): ${error?.message ?? "sin datos"}`,
    );
  }
  return data.id as number;
}

/**
 * Cierra una corrida: fija su estado final, los contadores y `finished_at`.
 *
 * Solo se escriben los contadores que se pasan explícitamente; los omitidos
 * conservan su valor por defecto (`0`).
 *
 * @param id    `id` devuelto por {@link startRun}.
 * @param opts  Estado final y contadores de la corrida.
 */
export async function finishRun(id: number, opts: FinishRunOptions): Promise<void> {
  const patch: Record<string, unknown> = {
    status: opts.status,
    finished_at: new Date().toISOString(),
  };
  if (opts.itemsFound !== undefined) patch.items_found = opts.itemsFound;
  if (opts.itemsNew !== undefined) patch.items_new = opts.itemsNew;
  if (opts.itemsProcessed !== undefined) patch.items_processed = opts.itemsProcessed;
  if (opts.error !== undefined) patch.error = opts.error;

  const { error } = await getAdminClient()
    .from("runs")
    .update(patch)
    .eq("id", id);

  if (error) {
    throw new Error(
      `finishRun: no se pudo cerrar la corrida ${id}: ${error.message}`,
    );
  }
}

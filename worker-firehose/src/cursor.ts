/**
 * Persistencia del cursor del firehose (`time_us`) en la tabla `settings`.
 *
 * El Jetstream permite reanudar desde un `cursor` en microsegundos unix: tras
 * una caída, reconectamos con el `time_us` del último evento procesado y el
 * servidor reproduce lo que nos perdimos (ventana de replay del lado de
 * Bluesky). Para sobrevivir reinicios/redeploys de Railway (que no garantizan
 * disco local), guardamos el cursor en Supabase, no en un archivo.
 *
 * Vive en `settings['firehose_cursor']` como JSONB (un número). Se escribe
 * THROTTLEADO (no en cada evento) para no martillar la base: ver el worker.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Clave en `settings` donde se guarda el cursor. */
const CURSOR_KEY = "firehose_cursor";

/**
 * Lee el cursor persistido, o `null` si nunca se guardó.
 *
 * `null` ⇒ arranque limpio: el worker se conecta sin `cursor` y empieza a
 * consumir desde "ahora" (live tail).
 */
export async function loadCursor(db: SupabaseClient): Promise<number | null> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", CURSOR_KEY)
    .maybeSingle();
  if (error) throw new Error(`loadCursor: ${error.message}`);
  const value = data?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Guarda el cursor (upsert por `key`).
 *
 * Usa `upsert` con `onConflict: 'key'` para crear la fila la primera vez y
 * actualizarla después. `updated_at` lo maneja la base (default/trigger).
 */
export async function saveCursor(db: SupabaseClient, timeUs: number): Promise<void> {
  const { error } = await db
    .from("settings")
    .upsert({ key: CURSOR_KEY, value: timeUs }, { onConflict: "key" });
  if (error) throw new Error(`saveCursor: ${error.message}`);
}

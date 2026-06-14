/**
 * Acceso a Supabase desde el worker: keywords, presupuesto e inserción de leads.
 *
 * El worker usa su PROPIO cliente supabase-js con la service-role key (bypassa
 * RLS, igual que `getAdminClient()` en la app, pero sin el árbol server-only de
 * Next.js). Tres responsabilidades:
 *
 * - `loadKeywords()`: lee la tabla `keywords` (sólo habilitadas) → el set del
 *   pre-filtro. Se cachea aguas arriba y se recarga cada ~5 min.
 * - `isClassifierPaused()`: lee `settings['classifier_paused']` → kill-switch del
 *   presupuesto. Se cachea aguas arriba y se refresca cada ~60 s.
 * - `insertLead()`: upsert con `ignoreDuplicates` (cubre los dos índices únicos).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Keyword } from "@/lib/filter/match";

import type { LeadRow } from "./types";

/**
 * Crea el cliente admin del worker (service role, sin sesión persistida).
 *
 * Mismas opciones que `getAdminClient()` en la app: sin auto-refresh ni
 * persistencia de sesión, porque es un cliente de servidor que sólo usa la
 * service-role key.
 */
export function createDbClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Carga las keywords habilitadas de la tabla `keywords`.
 *
 * Devuelve sólo `term`/`kind`/`lang` (la forma {@link Keyword} que consume el
 * pre-filtro puro), filtrando por `enabled = true` — igual que `loadKeywords()`
 * de `lib/filter/prefilter.ts` en la app.
 */
export async function loadKeywords(db: SupabaseClient): Promise<Keyword[]> {
  const { data, error } = await db
    .from("keywords")
    .select("term, kind, lang")
    .eq("enabled", true);
  if (error) throw new Error(`loadKeywords: ${error.message}`);
  return (data ?? []) as Keyword[];
}

/**
 * Lee el flag `classifier_paused` de `settings`.
 *
 * El valor es JSONB; lo tratamos como booleano. Ausente o no-`true` ⇒ no
 * pausado. Si la consulta falla, devolvemos `false` (fail-open): preferimos
 * seguir encolando a frenar la detección por un error transitorio de lectura;
 * el tope real lo hace cumplir `/api/process`, que es la autoridad del gasto.
 */
export async function isClassifierPaused(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", "classifier_paused")
    .maybeSingle();
  if (error) throw new Error(`isClassifierPaused: ${error.message}`);
  return data?.value === true;
}

/**
 * Inserta un lead deduplicado.
 *
 * Upsert con `ignoreDuplicates: true` y SIN target de conflicto: con dos índices
 * únicos (`content_hash` y `(source, external_id)`), nombrar uno haría que un
 * choque por el otro lance excepción. Sin target, ambos quedan cubiertos y el
 * duplicado se ignora silenciosamente — misma estrategia que `persistLeads()`.
 *
 * @returns `true` si insertó una fila nueva; `false` si era duplicado.
 */
export async function insertLead(db: SupabaseClient, row: LeadRow): Promise<boolean> {
  const { data, error } = await db
    .from("leads")
    .upsert(row, { ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`insertLead: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

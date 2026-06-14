/**
 * Carga de keywords desde la base + API pública del pre-filtro.
 *
 * La **lógica pura** del pre-filtro (matching de keywords, decisión de avance)
 * vive en `./match`, que no depende de red ni de `server-only` para poder
 * compartirse con el worker del firehose. Este módulo agrega lo que sí necesita
 * el servidor: leer las keywords habilitadas de la tabla `keywords`.
 *
 * Re-exporta `prefilter`, `decidePrefilter` y los tipos desde `./match`, así los
 * call-sites del lado app siguen importando todo desde `@/lib/filter/prefilter`
 * sin cambios.
 */

import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";

import type { Keyword } from "./match";

export { prefilter, decidePrefilter } from "./match";
export type { Keyword, PrefilterResult, Matchable } from "./match";

/**
 * Carga las keywords habilitadas desde la tabla `keywords`.
 *
 * Devuelve solo las filas con `enabled = true`. Pensada para llamarse una vez
 * por corrida de polling y reusar el resultado en todos los items de esa
 * corrida, en lugar de consultar la base por cada item.
 */
export async function loadKeywords(): Promise<Keyword[]> {
  const { data, error } = await getAdminClient()
    .from("keywords")
    .select("term, kind, lang")
    .eq("enabled", true);

  if (error) {
    throw new Error(`No se pudieron cargar las keywords: ${error.message}`);
  }
  return (data ?? []) as Keyword[];
}

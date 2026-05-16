/**
 * Pre-filtro determinístico por keywords.
 *
 * Antes de gastar en la clasificación con IA (paso 13), este filtro barato y
 * sin red descarta el grueso del ruido: un item solo avanza si su texto
 * contiene alguna keyword de inclusión y ninguna de exclusión. El criterio
 * favorece recall sobre precision — preferimos dejar pasar un falso positivo,
 * que la IA absorberá, antes que perder un lead real.
 */

import "server-only";

import { getAdminClient } from "@/lib/supabase/admin";
import type { RawItem } from "@/lib/sources/types";

import { normalizeText } from "./normalize";

/** Una keyword del pre-filtro, tal como vive en la tabla `keywords`. */
export interface Keyword {
  /** Término a buscar por substring sobre el texto normalizado. */
  term: string;
  /** `include` habilita el item; `exclude` lo descarta. */
  kind: "include" | "exclude";
  /** Idioma al que aplica; `any` aplica a cualquier idioma. */
  lang: "any" | "es" | "en";
}

/** Resultado de correr el pre-filtro sobre un item. */
export interface PrefilterResult {
  /** `true` si el item debe avanzar a la clasificación con IA. */
  passed: boolean;
  /**
   * Términos que matchearon: los de exclusión si el item se descartó, los de
   * inclusión si pasó, o vacío si no coincidió con nada.
   */
  matched: string[];
  /** Explicación legible de la decisión, apta para logs y para el dashboard. */
  reason: string;
}

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

/**
 * Aplica el pre-filtro de keywords a un item.
 *
 * Una keyword "aplica" si su `lang` es `any` o coincide con el idioma del item.
 * El texto normalizado (título + cuerpo) se compara por substring contra cada
 * keyword aplicable. Si matchea alguna keyword `exclude`, el item se descarta;
 * si no, pasa cuando matchea al menos una keyword `include`.
 *
 * @param item      Item crudo de una fuente.
 * @param lang      Idioma detectado del item (`'es'`, `'en'` u `'other'`).
 * @param keywords  Keywords habilitadas, tal como las devuelve `loadKeywords`.
 */
export function prefilter(
  item: RawItem,
  lang: string,
  keywords: Keyword[],
): PrefilterResult {
  const text = normalizeText(`${item.title} ${item.body}`);
  const applies = (kw: Keyword): boolean =>
    kw.lang === "any" || kw.lang === lang;
  const matches = (kw: Keyword): boolean =>
    text.includes(normalizeText(kw.term));

  const excluded = keywords
    .filter((kw) => kw.kind === "exclude" && applies(kw) && matches(kw))
    .map((kw) => kw.term);
  if (excluded.length > 0) {
    return {
      passed: false,
      matched: excluded,
      reason: `Excluido por keyword(s): ${excluded.join(", ")}`,
    };
  }

  const included = keywords
    .filter((kw) => kw.kind === "include" && applies(kw) && matches(kw))
    .map((kw) => kw.term);
  if (included.length > 0) {
    return {
      passed: true,
      matched: included,
      reason: `Coincidió con keyword(s) de inclusión: ${included.join(", ")}`,
    };
  }

  return {
    passed: false,
    matched: [],
    reason: "No coincidió con ninguna keyword de inclusión",
  };
}

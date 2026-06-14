/**
 * Lógica pura del pre-filtro determinístico por keywords.
 *
 * Este módulo NO toca red, base de datos ni `server-only`: sólo decide, dado un
 * item y un set de keywords, si avanza a la clasificación con IA. Vive separado
 * de `prefilter.ts` (que carga las keywords de la base, y por eso es
 * `server-only`) justamente para poder **compartirse**: lo importan tanto la app
 * de Next.js como el worker del firehose de Bluesky, que corre el mismo filtro
 * fuera de Vercel. Una sola copia de la lógica → cero divergencia entre lo que
 * filtra el worker y lo que el resto del sistema entiende por "lead".
 *
 * El criterio favorece recall sobre precision — preferimos dejar pasar un falso
 * positivo, que la IA (paga) absorberá, antes que perder un lead real.
 */

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
 * Forma mínima que necesita el matcher: título + cuerpo. {@link RawItem} la
 * cumple estructuralmente, así que cualquier item de fuente sirve de entrada sin
 * acoplar este módulo puro al tipo completo.
 */
export type Matchable = Pick<RawItem, "title" | "body">;

/**
 * Aplica el pre-filtro de keywords a un item.
 *
 * Una keyword "aplica" si su `lang` es `any` o coincide con el idioma del item.
 * El texto normalizado (título + cuerpo) se compara por substring contra cada
 * keyword aplicable. Si matchea alguna keyword `exclude`, el item se descarta;
 * si no, pasa cuando matchea al menos una keyword `include`.
 *
 * @param item      Item con `title` y `body` (ej. un {@link RawItem}).
 * @param lang      Idioma detectado del item (`'es'`, `'en'` u `'other'`).
 * @param keywords  Keywords habilitadas, tal como las devuelve `loadKeywords`.
 */
export function prefilter(
  item: Matchable,
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

/**
 * Decide si un item avanza a la clasificación, contemplando el bypass por fuente.
 *
 * Envuelve a {@link prefilter}: si la fuente declara `skipPrefilter`, el item
 * pasa siempre (sin mirar keywords) porque ya es un pedido de contratación
 * explícito; si no, delega en el pre-filtro de keywords normal.
 *
 * @param item           Item con `title` y `body`.
 * @param lang           Idioma detectado del item.
 * @param keywords       Keywords habilitadas (ver `loadKeywords`).
 * @param skipPrefilter  `true` si la fuente saltea el filtro de keywords.
 */
export function decidePrefilter(
  item: Matchable,
  lang: string,
  keywords: Keyword[],
  skipPrefilter: boolean,
): PrefilterResult {
  if (skipPrefilter) {
    return {
      passed: true,
      matched: [],
      reason: "Fuente de alta intención: se saltea el pre-filtro de keywords",
    };
  }
  return prefilter(item, lang, keywords);
}

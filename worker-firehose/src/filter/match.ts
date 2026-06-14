/**
 * Lógica pura del pre-filtro por keywords — COPIA VENDOREADA.
 *
 * Espejo de `lib/filter/match.ts` del app (ver `./normalize.ts` para el porqué
 * del vendoreo). Sin red, sin DB: dado un item y las keywords, decide si avanza.
 * El criterio favorece recall; la precisión fina la pone la IA (Capa 4).
 *
 * ⚠️ MANTENER EN SINCRONÍA con `lib/filter/match.ts`.
 */

import { normalizeText } from "./normalize";

/** Una keyword del pre-filtro, tal como vive en la tabla `keywords`. */
export interface Keyword {
  term: string;
  kind: "include" | "exclude";
  lang: "any" | "es" | "en";
}

/** Resultado de correr el pre-filtro sobre un item. */
export interface PrefilterResult {
  passed: boolean;
  matched: string[];
  reason: string;
}

/** Forma mínima que necesita el matcher: título + cuerpo. */
export type Matchable = { title: string; body: string };

/**
 * Aplica el pre-filtro de keywords. Una keyword "aplica" si su `lang` es `any` o
 * coincide con el idioma del item; matchea por substring sobre el texto
 * normalizado. Una `exclude` que matchea descarta; si no, pasa con ≥1 `include`.
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

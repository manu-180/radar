/**
 * Normalización de texto y utilidades del filtro — COPIA VENDOREADA.
 *
 * Espejo de `lib/filter/normalize.ts` del app. El worker es un servicio
 * standalone de Railway con **Root Directory = `worker-firehose`**: Railway sólo
 * sube esa carpeta al deployar, así que NO puede importar `../lib/filter/*`. Por
 * eso la lógica pura se vendorea acá.
 *
 * ⚠️ MANTENER EN SINCRONÍA con `lib/filter/normalize.ts`. El test
 * `src/lead.test.ts` compara el `contentHash` de esta copia contra el del app
 * (que importa por `@/…`), y falla si divergen — esa es la red de seguridad.
 */

import { createHash } from "node:crypto";

import { franc } from "franc-min";

/** Largo mínimo de texto para confiar en la detección de idioma (trigramas). */
const MIN_RELIABLE_LENGTH = 18;

/**
 * Marcas combinantes (acentos, tildes, virgulilla) que la descomposición NFD
 * separa de su letra base. Mismo rango que el app (`̀`–`ͯ`); se
 * construye desde string para mantener la fuente en ASCII puro.
 */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

/**
 * Lleva un texto a su forma canónica: minúsculas, sin diacríticos, espacios
 * colapsados y recortado. Idéntica a la del app.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hash SHA-256 estable del contenido, para deduplicar. Se calcula sobre el texto
 * normalizado de `título + cuerpo + URL` — EXACTAMENTE como el app (que recibe un
 * `RawItem`), para que el worker produzca el mismo `content_hash` que el
 * search-poll y el dedup sea perfecto.
 */
export function contentHash(item: {
  title: string;
  body: string;
  url: string;
}): string {
  const canonical = normalizeText(`${item.title} ${item.body} ${item.url}`);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Detecta el idioma de un texto: español, inglés o cualquier otro. Los textos
 * más cortos que {@link MIN_RELIABLE_LENGTH} caen en `'other'`.
 */
export function detectLang(text: string): "es" | "en" | "other" {
  const trimmed = text.trim();
  if (trimmed.length < MIN_RELIABLE_LENGTH) return "other";

  const code = franc(trimmed, { minLength: MIN_RELIABLE_LENGTH });
  if (code === "spa") return "es";
  if (code === "eng") return "en";
  return "other";
}

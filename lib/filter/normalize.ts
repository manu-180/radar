/**
 * Normalización de texto y utilidades del pre-filtro determinístico.
 *
 * Ninguna de estas funciones depende de red ni de entorno: llevan el texto
 * crudo de cualquier fuente a una forma canónica para comparar keywords,
 * deduplicar por hash y detectar idioma, todo sin gastar en IA.
 */

import { createHash } from "node:crypto";

import { franc } from "franc-min";

import type { RawItem } from "@/lib/sources/types";

/**
 * Largo mínimo de texto para confiar en la detección de idioma.
 *
 * `franc` usa un modelo de trigramas: en textos muy cortos hay pocos trigramas
 * y la clasificación es ruidosa, así que por debajo de este largo preferimos
 * declarar el idioma como desconocido.
 */
const MIN_RELIABLE_LENGTH = 18;

/**
 * Marcas combinantes (acentos, tildes, virgulilla) que la descomposición NFD
 * separa de su letra base. Eliminarlas vuelve la comparación insensible a
 * diacríticos: "á" pasa a "a", "ñ" pasa a "n".
 */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Lleva un texto a su forma canónica para comparaciones insensibles a formato.
 *
 * Pasa a minúsculas, descompone y elimina diacríticos (acentos, tildes y la
 * virgulilla de la ñ), colapsa toda secuencia de espacios en uno solo y recorta
 * los extremos. Así "Necesito  UN Desarrollador" y "necesito un desarrollador"
 * producen exactamente la misma cadena.
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
 * Hash SHA-256 estable del contenido de un item, para deduplicar.
 *
 * Se calcula sobre el texto normalizado de título + cuerpo + URL, por lo que un
 * mismo post reposteado con otro casing o con/sin acentos produce el mismo
 * hash y el sistema lo reconoce como duplicado.
 */
export function contentHash(item: RawItem): string {
  const canonical = normalizeText(`${item.title} ${item.body} ${item.url}`);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Detecta el idioma de un texto: español, inglés o cualquier otro.
 *
 * Usa `franc-min`. Cualquier idioma que no sea español ni inglés cae en
 * `'other'`, igual que los textos demasiado cortos para una detección
 * confiable (ver {@link MIN_RELIABLE_LENGTH}).
 */
export function detectLang(text: string): "es" | "en" | "other" {
  const trimmed = text.trim();
  if (trimmed.length < MIN_RELIABLE_LENGTH) return "other";

  const code = franc(trimmed, { minLength: MIN_RELIABLE_LENGTH });
  if (code === "spa") return "es";
  if (code === "eng") return "en";
  return "other";
}

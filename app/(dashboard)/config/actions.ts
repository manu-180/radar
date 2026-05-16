"use server";

/**
 * Server actions de la sección de keywords del panel de Configuración.
 *
 * Las keywords son la config del pre-filtro (paso 05): viven en la tabla
 * `keywords` y se editan desde acá sin tocar código. Cada acción revalida
 * `/config` para reflejar el cambio al instante; como `loadKeywords` relee la
 * tabla en cada corrida de polling, el cambio impacta en el próximo poll.
 */

import { revalidatePath } from "next/cache";

import { getAdminClient } from "@/lib/supabase/admin";

/** Tipos de keyword permitidos, alineados con el `check` de `keywords.kind`. */
const KINDS = ["include", "exclude"] as const;
/** Idiomas permitidos, alineados con el `check` de `keywords.lang`. */
const LANGS = ["any", "es", "en"] as const;
/** Largo máximo de un término; la tabla no lo acota, lo hacemos acá. */
const MAX_TERM_LENGTH = 200;

/** Un tipo de keyword válido (`include` habilita, `exclude` descarta). */
export type KeywordKind = (typeof KINDS)[number];
/** Un idioma de keyword válido; `any` aplica a cualquier idioma. */
export type KeywordLang = (typeof LANGS)[number];

/** Campos editables de una keyword, tal como llegan del formulario. */
export interface KeywordInput {
  term: string;
  kind: string;
  lang: string;
}

/** Resultado de una acción sobre keywords: éxito, o el motivo del fallo. */
export interface KeywordResult {
  ok: boolean;
  error?: string;
}

/**
 * Valida y normaliza los campos de una keyword.
 *
 * Devuelve los valores ya tipados si todo es válido, o un string con el motivo
 * del rechazo si algo no lo es.
 */
function parseInput(
  input: KeywordInput,
): { term: string; kind: KeywordKind; lang: KeywordLang } | string {
  const term = input.term.trim();
  if (!term) return "El término no puede estar vacío.";
  if (term.length > MAX_TERM_LENGTH) {
    return `El término no puede superar los ${MAX_TERM_LENGTH} caracteres.`;
  }
  if (!KINDS.includes(input.kind as KeywordKind)) {
    return "Tipo de keyword inválido.";
  }
  if (!LANGS.includes(input.lang as KeywordLang)) {
    return "Idioma inválido.";
  }
  return {
    term,
    kind: input.kind as KeywordKind,
    lang: input.lang as KeywordLang,
  };
}

/** `true` si `id` es un entero positivo, es decir un id real de la tabla. */
function isValidId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/** Agrega una keyword nueva al pre-filtro. Queda habilitada por defecto. */
export async function addKeyword(input: KeywordInput): Promise<KeywordResult> {
  const parsed = parseInput(input);
  if (typeof parsed === "string") return { ok: false, error: parsed };

  const { error } = await getAdminClient().from("keywords").insert(parsed);
  if (error) {
    return {
      ok: false,
      error: `No se pudo agregar la keyword: ${error.message}`,
    };
  }

  revalidatePath("/config");
  return { ok: true };
}

/** Edita el término, el tipo y el idioma de una keyword existente. */
export async function updateKeyword(
  id: number,
  input: KeywordInput,
): Promise<KeywordResult> {
  if (!isValidId(id)) return { ok: false, error: "Keyword inválida." };

  const parsed = parseInput(input);
  if (typeof parsed === "string") return { ok: false, error: parsed };

  const { error } = await getAdminClient()
    .from("keywords")
    .update(parsed)
    .eq("id", id);
  if (error) {
    return {
      ok: false,
      error: `No se pudo guardar la keyword: ${error.message}`,
    };
  }

  revalidatePath("/config");
  return { ok: true };
}

/**
 * Activa o desactiva una keyword sin borrarla.
 *
 * Una keyword desactivada queda en la tabla pero el pre-filtro la ignora, así
 * que sirve para silenciarla temporalmente sin perder su definición.
 */
export async function toggleKeyword(
  id: number,
  enabled: boolean,
): Promise<KeywordResult> {
  if (!isValidId(id)) return { ok: false, error: "Keyword inválida." };

  const { error } = await getAdminClient()
    .from("keywords")
    .update({ enabled })
    .eq("id", id);
  if (error) {
    return {
      ok: false,
      error: `No se pudo cambiar el estado: ${error.message}`,
    };
  }

  revalidatePath("/config");
  return { ok: true };
}

/** Borra una keyword de forma permanente. */
export async function deleteKeyword(id: number): Promise<KeywordResult> {
  if (!isValidId(id)) return { ok: false, error: "Keyword inválida." };

  const { error } = await getAdminClient()
    .from("keywords")
    .delete()
    .eq("id", id);
  if (error) {
    return {
      ok: false,
      error: `No se pudo borrar la keyword: ${error.message}`,
    };
  }

  revalidatePath("/config");
  return { ok: true };
}

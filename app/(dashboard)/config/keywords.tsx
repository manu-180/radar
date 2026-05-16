"use client";

/**
 * Controles interactivos de la sección de keywords del panel de Configuración.
 *
 * Client Components porque necesitan estado de edición y de carga. Cada uno
 * llama a una server action de `./actions`, que persiste el cambio y revalida
 * `/config`; la lista renderizada por la página se actualiza sola.
 */

import { useState, useTransition } from "react";

import {
  addKeyword,
  deleteKeyword,
  type KeywordKind,
  type KeywordLang,
  type KeywordResult,
  toggleKeyword,
  updateKeyword,
} from "./actions";

/** Una keyword tal como la página la pasa para mostrarla y editarla. */
export interface Keyword {
  id: number;
  term: string;
  kind: KeywordKind;
  lang: KeywordLang;
  enabled: boolean;
}

/** Opciones del select de tipo, en orden de aparición. */
const KIND_OPTIONS: { value: KeywordKind; label: string }[] = [
  { value: "include", label: "Inclusión" },
  { value: "exclude", label: "Exclusión" },
];

/** Opciones del select de idioma, en orden de aparición. */
const LANG_OPTIONS: { value: KeywordLang; label: string }[] = [
  { value: "any", label: "Cualquiera" },
  { value: "es", label: "Español" },
  { value: "en", label: "Inglés" },
];

/** Clases compartidas de inputs y selects. */
const FIELD_CLASS = "rounded-md border border-zinc-300 px-2 py-1.5 text-sm";

/**
 * Formulario para agregar una keyword nueva.
 *
 * Al guardar con éxito limpia el término y vuelve los selectores a su valor
 * por defecto, listo para cargar la siguiente.
 */
export function AddKeywordForm() {
  const [term, setTerm] = useState("");
  const [kind, setKind] = useState<KeywordKind>("include");
  const [lang, setLang] = useState<KeywordLang>("any");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await addKeyword({ term, kind, lang });
      if (result.ok) {
        setTerm("");
        setKind("include");
        setLang("any");
      } else {
        setError(result.error ?? "No se pudo agregar la keyword.");
      }
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 p-3"
    >
      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Término
        <input
          type="text"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Ej. looking for a developer"
          required
          className={`${FIELD_CLASS} min-w-64`}
        />
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Tipo
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as KeywordKind)}
          className={FIELD_CLASS}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs font-medium text-zinc-500">
        Idioma
        <select
          value={lang}
          onChange={(event) => setLang(event.target.value as KeywordLang)}
          className={FIELD_CLASS}
        >
          {LANG_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        disabled={pending || !term.trim()}
        className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
      >
        Agregar
      </button>

      {error && (
        <p role="alert" className="w-full text-sm text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Fila editable de una keyword: edita término/tipo/idioma, la activa o
 * desactiva, y la borra.
 *
 * El estado de edición arranca con los valores de la keyword. "Guardar" sólo
 * se habilita si algo cambió. Tras una acción exitosa, la página revalida y
 * vuelve a renderizar la fila con los datos frescos.
 */
export function KeywordRow({ keyword }: { keyword: Keyword }) {
  const [term, setTerm] = useState(keyword.term);
  const [kind, setKind] = useState<KeywordKind>(keyword.kind);
  const [lang, setLang] = useState<KeywordLang>(keyword.lang);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty =
    term.trim() !== keyword.term ||
    kind !== keyword.kind ||
    lang !== keyword.lang;

  /** Corre una server action y muestra su error si falla. */
  function run(action: () => Promise<KeywordResult>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "No se pudo completar la acción.");
      }
    });
  }

  return (
    <li className="space-y-2 rounded-md border border-zinc-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          aria-label="Término de la keyword"
          className={`${FIELD_CLASS} min-w-64 flex-1 ${
            keyword.enabled ? "" : "text-zinc-400"
          }`}
        />

        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as KeywordKind)}
          aria-label="Tipo de la keyword"
          className={FIELD_CLASS}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          value={lang}
          onChange={(event) => setLang(event.target.value as KeywordLang)}
          aria-label="Idioma de la keyword"
          className={FIELD_CLASS}
        >
          {LANG_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            keyword.enabled
              ? "bg-green-100 text-green-800"
              : "bg-zinc-100 text-zinc-500"
          }`}
        >
          {keyword.enabled ? "Activa" : "Inactiva"}
        </span>

        <button
          type="button"
          disabled={pending || !dirty}
          onClick={() =>
            run(() => updateKeyword(keyword.id, { term, kind, lang }))
          }
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60"
        >
          Guardar
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => toggleKeyword(keyword.id, !keyword.enabled))}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-60"
        >
          {keyword.enabled ? "Desactivar" : "Activar"}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => deleteKeyword(keyword.id))}
          className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
        >
          Borrar
        </button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}

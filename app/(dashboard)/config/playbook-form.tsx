"use client";

/**
 * Formulario del Playbook del closer.
 *
 * Isla de cliente: edita los seis campos del guion (persona, oferta, precios,
 * tono, objetivo, disparadores de handoff) y los guarda con {@link updatePlaybook}.
 * "Guardar" sólo se habilita si algo cambió respecto de lo persistido. Tras un
 * guardado OK la página revalida y este form remonta con los valores frescos.
 */

import { useState, useTransition } from "react";

import { type PlaybookInput, updatePlaybook } from "./autopilot-actions";

import { FIELD_CLASS, PRIMARY_BTN } from "../ui";

/** Definición de cada campo: clave, rótulo, ayuda y alto del textarea. */
const FIELDS: {
  key: keyof PlaybookInput;
  label: string;
  hint: string;
  rows: number;
}[] = [
  {
    key: "persona",
    label: "Persona",
    hint: "Quién es el agente y cómo habla.",
    rows: 3,
  },
  {
    key: "offer",
    label: "Oferta",
    hint: "Qué ofrece: servicios, stack, diferencial.",
    rows: 3,
  },
  {
    key: "pricing",
    label: "Precios",
    hint: "Rangos de precio y la regla de no cerrar fuera de rango.",
    rows: 3,
  },
  {
    key: "tone",
    label: "Tono",
    hint: "Tono y forma de los mensajes (largo, ritmo, estilo).",
    rows: 2,
  },
  {
    key: "goal",
    label: "Objetivo",
    hint: "A dónde tiene que llevar la conversación.",
    rows: 2,
  },
  {
    key: "handoff_triggers",
    label: "Disparadores de handoff",
    hint: "Señales que derivan el lead a vos (pide boceto, presupuesto, llamada…).",
    rows: 3,
  },
];

export function PlaybookForm({ playbook }: { playbook: PlaybookInput }) {
  const [values, setValues] = useState<PlaybookInput>(playbook);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = FIELDS.some(
    (f) => (values[f.key] ?? "").trim() !== (playbook[f.key] ?? "").trim(),
  );

  function set(key: keyof PlaybookInput, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updatePlaybook(values);
      if (result.ok) setSaved(true);
      else setError(result.error ?? "No se pudo guardar el playbook.");
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label
            key={f.key}
            className={`flex flex-col gap-1.5 ${f.rows >= 3 ? "sm:col-span-2" : ""}`}
          >
            <span className="text-sm font-medium text-[var(--foreground)]">
              {f.label}
            </span>
            <textarea
              value={values[f.key] ?? ""}
              onChange={(e) => set(f.key, e.target.value)}
              rows={f.rows}
              aria-label={f.label}
              className={`${FIELD_CLASS} w-full resize-y leading-relaxed`}
            />
            <span className="text-xs text-[var(--subtle)]">{f.hint}</span>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending || !dirty}
          onClick={handleSave}
          className={PRIMARY_BTN}
        >
          {pending ? "Guardando…" : "Guardar playbook"}
        </button>
        {saved && !dirty && (
          <span className="text-sm text-[var(--ok-soft-fg)]">Guardado ✓</span>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--danger-soft-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

/**
 * Botones de feedback del detalle de lead.
 *
 * Client Component: necesita estado de carga y reflejar la opción activa al
 * instante. Llama a la server action {@link setLeadFeedback}, que persiste el
 * valor y revalida la página; el feedback marcado queda resaltado.
 */

import { useState, useTransition } from "react";

import { type FeedbackValue, setLeadFeedback } from "./actions";

/** Las tres opciones de feedback, en orden de aparición. */
const OPTIONS: { value: FeedbackValue; label: string }[] = [
  { value: "responded", label: "Respondí" },
  { value: "interested", label: "Me interesa" },
  { value: "not_relevant", label: "No relevante" },
];

export function FeedbackButtons({
  leadId,
  current,
}: {
  leadId: number;
  /** Feedback ya guardado del lead, o `null` si todavía no tiene. */
  current: FeedbackValue | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick(value: FeedbackValue) {
    setError(null);
    startTransition(async () => {
      const result = await setLeadFeedback(leadId, value);
      if (!result.ok) setError(result.error ?? "No se pudo guardar el feedback.");
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((option) => {
          const active = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={pending}
              aria-pressed={active}
              onClick={() => handleClick(option.value)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
                active
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-100"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

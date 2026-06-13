"use client";

/**
 * Interruptor de autopilot de una conversación.
 *
 * Isla de cliente: necesita estado optimista y de carga. Llama a la server
 * action {@link setAutopilot}, que persiste y revalida. Mientras la acción está
 * en vuelo el switch muestra el valor pretendido (optimista); si falla, vuelve
 * al valor real y muestra el error vía `title`. Accesible como `switch`.
 */

import { useState, useTransition } from "react";

import { setAutopilot } from "./actions";

export function AutopilotToggle({
  conversationId,
  on,
  size = "md",
  label = true,
}: {
  conversationId: number;
  on: boolean;
  size?: "sm" | "md";
  label?: boolean;
}) {
  const [optimistic, setOptimistic] = useState(on);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !optimistic;
    setOptimistic(next);
    setError(null);
    startTransition(async () => {
      const result = await setAutopilot(conversationId, next);
      if (!result.ok) {
        setOptimistic(!next); // revertir
        setError(result.error ?? "No se pudo cambiar el autopilot.");
      }
    });
  }

  const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knob = size === "sm" ? "h-[14px] w-[14px]" : "h-[18px] w-[18px]";
  const knobOn = size === "sm" ? "translate-x-4" : "translate-x-5";

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={optimistic}
        aria-label={`Autopilot ${optimistic ? "activado" : "desactivado"}`}
        title={error ?? undefined}
        disabled={pending}
        onClick={toggle}
        className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors focus-ring disabled:opacity-60 ${
          optimistic ? "bg-[var(--ok-solid)]" : "bg-[var(--border-strong)]"
        }`}
      >
        <span
          className={`inline-block ${knob} transform rounded-full bg-white shadow transition-transform ${
            optimistic ? knobOn : "translate-x-0.5"
          }`}
        />
      </button>
      {label && (
        <span
          className={`text-xs font-medium ${
            optimistic ? "text-[var(--ok-soft-fg)]" : "text-[var(--subtle)]"
          }`}
        >
          {optimistic ? "Autopilot" : "Manual"}
        </span>
      )}
    </span>
  );
}

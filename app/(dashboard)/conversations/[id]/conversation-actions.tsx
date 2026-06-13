"use client";

/**
 * Botones de acción del thread: marcar Ganado/Perdido y Pausar/Reanudar.
 *
 * Isla de cliente. Llaman a {@link setConversationStatus}, que valida el estado
 * destino contra los permitidos y revalida el thread. El botón de pausa alterna
 * entre `paused` y `awaiting_reply` (reanudar). Estado de carga compartido para
 * que no se disparen dos a la vez; el error se muestra debajo.
 */

import { useState, useTransition } from "react";

import type { ConversationStatus } from "@/types/autopilot";

import { setConversationStatus } from "../actions";

const WON_LOST_DONE: ConversationStatus[] = ["won", "lost", "disqualified"];

export function ConversationActions({
  conversationId,
  status,
}: {
  conversationId: number;
  status: ConversationStatus;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isPaused = status === "paused";
  const isClosed = WON_LOST_DONE.includes(status);

  function run(next: "won" | "lost" | "paused" | "awaiting_reply") {
    setError(null);
    startTransition(async () => {
      const result = await setConversationStatus(conversationId, next);
      if (!result.ok) setError(result.error ?? "No se pudo completar la acción.");
    });
  }

  const btn =
    "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-ring disabled:opacity-50 disabled:pointer-events-none";

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={pending || status === "won"}
          onClick={() => run("won")}
          className={`${btn} bg-[var(--ok-soft)] text-[var(--ok-soft-fg)] hover:brightness-95`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Ganado
        </button>
        <button
          type="button"
          disabled={pending || status === "lost"}
          onClick={() => run("lost")}
          className={`${btn} bg-[var(--danger-soft)] text-[var(--danger-soft-fg)] hover:brightness-95`}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Perdido
        </button>
      </div>

      <button
        type="button"
        disabled={pending || isClosed}
        onClick={() => run(isPaused ? "awaiting_reply" : "paused")}
        title={
          isClosed
            ? "La conversación ya está cerrada."
            : undefined
        }
        className={`${btn} w-full border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-[var(--surface-2)]`}
      >
        {isPaused ? (
          <>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="m5 3 14 9-14 9V3Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Reanudar conversación
          </>
        ) : (
          <>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="M6 4h4v16H6zM14 4h4v16h-4z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Pausar conversación
          </>
        )}
      </button>

      {error && (
        <p role="alert" className="text-sm text-[var(--danger-soft-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}

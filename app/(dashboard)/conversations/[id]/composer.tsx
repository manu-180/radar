"use client";

/**
 * Composer del thread: escribir y enviar un mensaje a mano como dueño.
 *
 * Isla de cliente. Llama a {@link sendOwnerReply}, que envía por el canal de la
 * conversación (`role='owner'`) y revalida el thread, así el mensaje aparece
 * solo en la lista. Limpia el textarea al enviar OK; muestra el error si falla.
 * `Cmd/Ctrl + Enter` envía. El textarea crece con el contenido (auto-resize).
 */

import { useRef, useState, useTransition } from "react";

import { sendOwnerReply } from "../actions";

export function Composer({
  conversationId,
  autopilotOn,
}: {
  conversationId: number;
  autopilotOn: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLTextAreaElement>(null);

  function autoresize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  function submit() {
    const body = text.trim();
    if (!body || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await sendOwnerReply(conversationId, body);
      if (result.ok) {
        setText("");
        if (ref.current) ref.current.style.height = "auto";
      } else {
        setError(result.error ?? "No se pudo enviar el mensaje.");
      }
    });
  }

  return (
    <div className="border-t border-[var(--border)] bg-[var(--surface)] p-3">
      {autopilotOn && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-[var(--warn-soft-fg)]">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
            <path d="M12 9v4M12 17h.01M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          El autopilot está activo: si escribís vos, conviene pausarlo para no
          pisarte con el agente.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-end gap-2"
      >
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoresize();
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Escribí un mensaje…  (⌘/Ctrl + Enter para enviar)"
          aria-label="Mensaje para el lead"
          className="max-h-52 min-h-[42px] flex-1 resize-none rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--subtle)] focus-ring scroll-elegant"
        />
        <button
          type="submit"
          disabled={pending || !text.trim()}
          className="inline-flex h-[42px] items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] focus-ring disabled:opacity-50 disabled:pointer-events-none"
        >
          {pending ? (
            "Enviando…"
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                <path d="m22 2-7 20-4-9-9-4 20-7Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Enviar
            </>
          )}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--danger-soft-fg)]">
          {error}
        </p>
      )}
    </div>
  );
}

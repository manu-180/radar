"use client";

/**
 * Botón para copiar el mensaje sugerido al portapapeles.
 *
 * Client Component mínimo: el único motivo por el que existe es que copiar
 * necesita `navigator.clipboard`, que solo corre en el navegador. El texto a
 * copiar llega como prop desde el Server Component del detalle.
 */

import { useState } from "react";

/** Cuánto dura el estado "Copiado" antes de volver a "Copiar", en ms. */
const FEEDBACK_MS = 2000;

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), FEEDBACK_MS);
    } catch {
      // Algunos navegadores bloquean el portapapeles sin gesto/permiso:
      // dejamos el botón como estaba para que el usuario reintente.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
    >
      {copied ? "✓ Copiado" : "Copiar"}
    </button>
  );
}

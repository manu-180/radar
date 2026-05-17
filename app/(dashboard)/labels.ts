/**
 * Etiquetas y estilos compartidos del dashboard.
 *
 * Mapas "valor de la base → texto legible / clases de color" que el listado de
 * leads (`/leads`) y el detalle de lead (`/leads/[id]`) mostraban por
 * duplicado. Centralizarlos acá evita que las dos vistas se desincronicen —un
 * estado nuevo, una etiqueta o un color distinto— y deja un único lugar donde
 * tocarlos.
 */

/** Clases Tailwind del badge de cada categoría de lead. */
export const CATEGORY_BADGE: Record<string, string> = {
  hiring: "bg-green-100 text-green-800",
  maybe: "bg-amber-100 text-amber-800",
  noise: "bg-zinc-100 text-zinc-600",
};

/** Etiqueta legible de cada estado de clasificación con IA (`leads.llm_status`). */
export const LLM_STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  processing: "Procesando",
  done: "Clasificado",
  failed: "Falló",
  skipped: "Descartado",
};

/** Etiqueta legible de cada estado de notificación (`leads.notify_status`). */
export const NOTIFY_LABELS: Record<string, string> = {
  pending: "Pendiente",
  sending: "Enviando",
  sent: "Enviada",
  failed: "Falló",
  skipped: "Descartada",
};

/** Etiqueta legible de cada valor de feedback (`leads.feedback`). */
export const FEEDBACK_LABELS: Record<string, string> = {
  responded: "Respondido",
  interested: "Interesado",
  not_relevant: "No relevante",
};

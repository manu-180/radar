/**
 * Fila de `leads` lista para insertar desde el worker.
 *
 * Es una copia local del subconjunto de columnas que el worker escribe, con la
 * misma forma que `LeadRow` de `lib/db/leads.ts` en la app. NO se importa de
 * ahí a propósito: ese módulo abre con `import "server-only"`, que lanza fuera
 * de Next.js (y esbuild lo intentaría bundlear). Mantener una copia chica acá es
 * más barato que arrastrar todo el árbol server-only del app.
 *
 * Las columnas y sus tipos están verificados contra el esquema real de la tabla
 * `leads` (information_schema). El worker siempre encola con estado `'pending'`
 * (nunca `'skipped'`: lo que no pasa el filtro no se inserta).
 */
export interface LeadRow {
  /** Slug de la fuente; el worker usa siempre `'bluesky'`. */
  source: string;
  /** URI `at://…` del post: el ID del item en la fuente. */
  external_id: string | null;
  /** Hash del contenido (idéntico al del search-poll): identidad para deduplicar. */
  content_hash: string;
  /** Título derivado de la primera línea del post. */
  title: string | null;
  /** Cuerpo: el texto completo del post. */
  body: string | null;
  /** URL pública del post en bsky.app. */
  url: string | null;
  /** Handle del autor (sin `@`). */
  author: string | null;
  /** Idioma detectado (`'es'` u `'other'`; el `'en'` no llega a insertarse). */
  lang: string | null;
  /** `createdAt` del post en ISO 8601, o `null`. */
  posted_at: string | null;
  /** Evento original del Jetstream. */
  raw: unknown;
  /** Keywords de inclusión que matchearon. */
  prefilter_matched: string[] | null;
  /** Estado en la cola de clasificación (siempre `'pending'` desde el worker). */
  llm_status: "pending";
  /** Estado en la cola de notificación (siempre `'pending'` desde el worker). */
  notify_status: "pending";
  /** Canal de contacto del autor: `'bluesky'`. */
  contact_channel: string | null;
  /** Clave de ruteo del autor: su DID. */
  contact_key: string | null;
  /** Direccionamiento opaco del autor: `{ did }`. */
  contact_ref: unknown;
  /** Handle legible del autor: `'@' + handle`. */
  contact_handle: string | null;
}

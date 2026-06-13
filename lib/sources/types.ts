/**
 * Tipos base del patrón de adaptadores de fuente.
 *
 * Cada fuente que monitorea Lead Detector (Hacker News, Reddit, Bluesky, etc.)
 * implementa la interfaz {@link SourceAdapter}. Gracias a esto, agregar una
 * fuente nueva es crear un archivo que cumpla el contrato y registrarlo en el
 * registry — ningún otro código del sistema cambia.
 */

import type { ZodType } from "zod";

import type { LeadContact } from "@/types/autopilot";

/**
 * Item crudo de una fuente, ya normalizado a una forma común.
 *
 * Es la representación neutral que produce cada adaptador antes de que el
 * pre-filtro y el clasificador de IA decidan si es un lead. El campo `raw`
 * conserva la respuesta original de la fuente por si hace falta inspeccionarla.
 */
export interface RawItem {
  /** ID del item en la fuente de origen; `null` si la fuente no expone uno. */
  externalId: string | null;
  /** Título del post. */
  title: string;
  /** Cuerpo o texto principal del post. */
  body: string;
  /** URL pública del item. */
  url: string;
  /** Autor del post; `null` si la fuente no lo expone. */
  author: string | null;
  /** Fecha de publicación en ISO 8601; `null` si se desconoce. */
  postedAt: string | null;
  /** Respuesta original de la fuente, sin transformar. */
  raw: unknown;
  /**
   * Cómo contactar al autor para una conversación de outreach (v2). Sólo lo
   * producen las fuentes cuyo autor es contactable (ej. Telegram en grupos,
   * Bluesky, Reddit). `null`/ausente = no contactable: el lead se detecta y se
   * avisa, pero no se auto-engancha.
   */
  contact?: LeadContact | null;
}

/**
 * High-water-mark del polling incremental de una fuente.
 *
 * Es un objeto JSON serializable y opaco: cada adaptador define su propia
 * forma (último ID visto, timestamp, token de paginación, etc.). El sistema
 * solo lo persiste en la columna `cursor` de `sources` y se lo devuelve a la
 * fuente en la siguiente corrida.
 */
export type SourceCursor = Record<string, unknown>;

/** Resultado de una corrida de polling: items nuevos y cursor actualizado. */
export interface FetchResult {
  /** Items nuevos traídos en esta corrida. */
  items: RawItem[];
  /** Cursor actualizado a persistir para la próxima corrida. */
  cursor: SourceCursor;
}

/**
 * Contrato que implementa cada fuente monitoreada.
 *
 * El `config` que recibe `fetchItems` ya viene validado contra `configSchema`,
 * así que el adaptador puede asumir que es correcto.
 */
export interface SourceAdapter {
  /** Identificador estable de la fuente; coincide con `sources.slug`. */
  slug: string;
  /** Nombre legible para humanos (UI, logs). */
  displayName: string;
  /** Schema de Zod que valida el `config` propio de esta fuente. */
  configSchema: ZodType;
  /**
   * Trae los items nuevos desde la última corrida.
   *
   * @param config  Config de la fuente, ya validado contra `configSchema`.
   * @param cursor  Cursor devuelto por la corrida anterior (el de arranque
   *                es `{}`, el default de la columna `cursor`).
   * @returns Los items nuevos y el cursor actualizado.
   */
  fetchItems(config: unknown, cursor: SourceCursor): Promise<FetchResult>;
}

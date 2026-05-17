/**
 * Nombres legibles de las fuentes — fuente de verdad única.
 *
 * El `slug` de una fuente (`hackernews`, `reddit`, …) es su identificador
 * estable; su nombre legible vive acá. El armado del mensaje de WhatsApp tenía
 * antes su propio mapa parcial —le faltaban `discord`, `telegram` y `workana`,
 * y nombraba a otras distinto que el resto del sistema—; este módulo centraliza
 * el mapa para que todos los consumidores muestren el mismo nombre.
 *
 * Es un módulo **hoja, sin dependencias**: importarlo no arrastra adaptadores
 * ni clientes pesados, así que es seguro usarlo desde cualquier lado.
 */

/**
 * Nombre legible de cada fuente, indexado por su slug. Coincide con el
 * `displayName` del adaptador y con la columna `sources.name` de la base.
 */
export const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  hackernews: "Hacker News",
  reddit: "Reddit",
  bluesky: "Bluesky",
  freelancer: "Freelancer.com",
  rss: "Feeds RSS",
  telegram: "Telegram",
  discord: "Discord",
  workana: "Workana",
};

/**
 * Nombre legible de una fuente a partir de su slug. Si el slug no está en el
 * mapa, capitaliza su primera letra como fallback razonable.
 */
export function sourceDisplayName(slug: string): string {
  const known = SOURCE_DISPLAY_NAMES[slug];
  if (known) return known;
  return slug ? slug[0].toUpperCase() + slug.slice(1) : "Desconocida";
}

/**
 * Punto de entrada del subsistema de fuentes.
 *
 * Re-exporta el registry y los tipos del patrón de adaptadores, e importa cada
 * adaptador concreto (Hacker News, Reddit, etc.) para forzar su registro como
 * efecto secundario del import. Importar este módulo deja todas las fuentes
 * disponibles vía `getSource`/`listSources`.
 */

// Efecto secundario: cada import registra su adaptador en el registry.
import "@/lib/sources/hackernews";
import "@/lib/sources/reddit";
import "@/lib/sources/bluesky";
import "@/lib/sources/freelancer";

export { registerSource, getSource, listSources } from "@/lib/sources/registry";
export type {
  RawItem,
  SourceCursor,
  FetchResult,
  SourceAdapter,
} from "@/lib/sources/types";

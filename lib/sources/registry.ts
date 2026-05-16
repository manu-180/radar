/**
 * Registry de adaptadores de fuente.
 *
 * Mantiene un `Map` interno de `slug` → {@link SourceAdapter}. Cada adaptador
 * se registra una sola vez (típicamente al importar su módulo) y el resto del
 * sistema lo resuelve por `slug`. Esto desacopla al polling de las fuentes
 * concretas: agregar una fuente nueva no toca este archivo.
 */

import type { SourceAdapter } from "@/lib/sources/types";

const registry = new Map<string, SourceAdapter>();

/**
 * Registra un adaptador de fuente.
 *
 * Lanza si ya hay un adaptador con el mismo `slug`: dos fuentes que comparten
 * slug es un error de programación (import duplicado o slug repetido).
 */
export function registerSource(adapter: SourceAdapter): void {
  if (registry.has(adapter.slug)) {
    throw new Error(`Fuente ya registrada: "${adapter.slug}"`);
  }
  registry.set(adapter.slug, adapter);
}

/** Devuelve el adaptador registrado para `slug`, o `undefined` si no existe. */
export function getSource(slug: string): SourceAdapter | undefined {
  return registry.get(slug);
}

/** Devuelve todos los adaptadores registrados. */
export function listSources(): SourceAdapter[] {
  return [...registry.values()];
}

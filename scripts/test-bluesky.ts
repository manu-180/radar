/**
 * Smoke test del adaptador de Bluesky.
 *
 * Corré con:  npx tsx scripts/test-bluesky.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 y el cursor resultante. No toca la base de datos: el config replica la fila
 * semilla de `sources` con slug `bluesky`.
 */

import { getSource } from "@/lib/sources";

/** Config real de la fuente `bluesky` (espejo de la fila semilla en `sources`). */
const CONFIG = {
  queries: [
    "looking for a developer",
    "need a developer",
    "hire a developer",
    "necesito un desarrollador",
    "busco programador",
  ],
};

async function main(): Promise<void> {
  const adapter = getSource("bluesky");
  if (!adapter) {
    throw new Error("El adaptador 'bluesky' no está registrado en el registry");
  }

  console.log("Ejecutando adaptador 'bluesky' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  for (const item of result.items.slice(0, 3)) {
    console.log("─".repeat(60));
    console.log(`  externalId : ${item.externalId}`);
    console.log(`  title      : ${item.title}`);
    console.log(`  body       : ${item.body.slice(0, 160)}`);
    console.log(`  url        : ${item.url}`);
    console.log(`  author     : ${item.author}`);
    console.log(`  postedAt   : ${item.postedAt}`);
  }

  console.log("─".repeat(60));
  console.log(`\nCursor resultante: ${JSON.stringify(result.cursor)}`);
}

main().catch((err) => {
  console.error("test-bluesky falló:", err);
  process.exit(1);
});

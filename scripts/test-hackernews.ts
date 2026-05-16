/**
 * Smoke test del adaptador de Hacker News.
 *
 * Corré con:  npx tsx scripts/test-hackernews.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 y el cursor resultante. No toca la base de datos: el config replica la fila
 * semilla de `sources` con slug `hackernews`.
 */

import { getSource } from "@/lib/sources";

/** Config real de la fuente `hackernews` (espejo de la fila semilla en `sources`). */
const CONFIG = {
  keywordQueries: ["developer", "web app", "mobile app"],
  includeWhoIsHiring: true,
};

async function main(): Promise<void> {
  const adapter = getSource("hackernews");
  if (!adapter) {
    throw new Error("El adaptador 'hackernews' no está registrado en el registry");
  }

  console.log("Ejecutando adaptador 'hackernews' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  for (const item of result.items.slice(0, 3)) {
    console.log("─".repeat(60));
    console.log(`  externalId : ${item.externalId}`);
    console.log(`  title      : ${item.title}`);
    console.log(`  url        : ${item.url}`);
    console.log(`  author     : ${item.author}`);
    console.log(`  postedAt   : ${item.postedAt}`);
    console.log(`  body       : ${item.body.slice(0, 200).replace(/\n/g, " ")}…`);
  }

  console.log("─".repeat(60));
  console.log(`\nCursor resultante: ${JSON.stringify(result.cursor)}`);
}

main().catch((err) => {
  console.error("test-hackernews falló:", err);
  process.exit(1);
});

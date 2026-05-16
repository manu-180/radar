/**
 * Smoke test del adaptador de Reddit.
 *
 * Corré con:  npx tsx scripts/test-reddit.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 (título + flair) y el cursor resultante. No toca la base de datos: el config
 * replica la fila semilla de `sources` con slug `reddit`.
 */

import { getSource } from "@/lib/sources";

/** Config real de la fuente `reddit` (espejo de la fila semilla en `sources`). */
const CONFIG = {
  subreddits: ["forhire", "jobbit", "slavelabour", "DoneDirtCheap", "hiring"],
  hiringFlairOnly: true,
};

async function main(): Promise<void> {
  const adapter = getSource("reddit");
  if (!adapter) {
    throw new Error("El adaptador 'reddit' no está registrado en el registry");
  }

  console.log("Ejecutando adaptador 'reddit' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  for (const item of result.items.slice(0, 3)) {
    const flair = (item.raw as { link_flair_text?: string | null })
      .link_flair_text;
    console.log("─".repeat(60));
    console.log(`  externalId : ${item.externalId}`);
    console.log(`  title      : ${item.title}`);
    console.log(`  flair      : ${flair ?? "(sin flair)"}`);
    console.log(`  url        : ${item.url}`);
    console.log(`  author     : ${item.author}`);
    console.log(`  postedAt   : ${item.postedAt}`);
  }

  console.log("─".repeat(60));
  console.log(`\nCursor resultante: ${JSON.stringify(result.cursor)}`);
}

main().catch((err) => {
  console.error("test-reddit falló:", err);
  process.exit(1);
});

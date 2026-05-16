/**
 * Smoke test del adaptador de feeds RSS genérico.
 *
 * Corré con:  npx tsx scripts/test-rss.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo cada feed,
 * los primeros 3 items y el cursor resultante. No toca la base de datos: el
 * config replica la fila semilla de `sources` con slug `rss`.
 *
 * Cada item lleva el nombre de su feed en `author`, así que el conteo por feed
 * sale de agrupar los items por ese campo.
 *
 * Importa el adaptador `rss` directo (no vía `@/lib/sources`) para no arrastrar
 * el resto de fuentes ni la validación de entorno: el adaptador RSS no usa
 * ninguna variable de entorno, así que el script corre con `npx tsx` pelado.
 */

// Efecto secundario: registra el adaptador `rss` en el registry.
import "@/lib/sources/rss";
import { getSource } from "@/lib/sources/registry";

/** Config real de la fuente `rss` (espejo de la fila semilla en `sources`). */
const CONFIG = {
  feeds: [
    {
      name: "craigslist-sfbay",
      url: "https://sfbay.craigslist.org/search/cpg?format=rss",
    },
    {
      name: "craigslist-newyork",
      url: "https://newyork.craigslist.org/search/cpg?format=rss",
    },
    {
      name: "weworkremotely-prog",
      url: "https://weworkremotely.com/categories/remote-programming-jobs.rss",
    },
    {
      name: "weworkremotely-fullstack",
      url: "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
    },
    {
      name: "remotive-software-dev",
      url: "https://remotive.com/remote-jobs/feed?category=software-dev",
    },
    {
      name: "jobicy-dev",
      url: "https://jobicy.com/?feed=job_feed&job_categories=dev",
    },
  ],
};

async function main(): Promise<void> {
  const adapter = getSource("rss");
  if (!adapter) {
    throw new Error("El adaptador 'rss' no está registrado en el registry");
  }

  console.log("Ejecutando adaptador 'rss' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  // Conteo por feed: el nombre del feed viaja en `author`.
  console.log("Items por feed:");
  for (const feed of CONFIG.feeds) {
    const count = result.items.filter((i) => i.author === feed.name).length;
    console.log(`  ${feed.name.padEnd(26)} ${count}`);
  }
  console.log();

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
  console.log(`\nCursor resultante: ${JSON.stringify(result.cursor, null, 2)}`);

  if (result.items.length === 0) {
    throw new Error("Ningún feed trajo items: se esperaba al menos uno.");
  }
}

main().catch((err) => {
  console.error("test-rss falló:", err);
  process.exit(1);
});

/**
 * Smoke test del adaptador de Freelancer.com.
 *
 * Corré con:  npx tsx scripts/test-freelancer.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 y el cursor resultante. No toca la base de datos: el config replica la fila
 * semilla de `sources` con slug `freelancer`.
 *
 * Sin `FREELANCER_OAUTH_TOKEN` la fuente queda inerte: el script confirma que
 * el adaptador devuelve `[]` sin lanzar error.
 */

import { env } from "@/lib/env";
import { getSource } from "@/lib/sources";

/** Config real de la fuente `freelancer` (espejo de la fila semilla en `sources`). */
const CONFIG = {
  queries: ["website", "web app", "mobile app", "next.js"],
};

async function main(): Promise<void> {
  const adapter = getSource("freelancer");
  if (!adapter) {
    throw new Error(
      "El adaptador 'freelancer' no está registrado en el registry",
    );
  }

  if (!env.FREELANCER_OAUTH_TOKEN) {
    console.log("FREELANCER_OAUTH_TOKEN no está seteado.");
    console.log("Se espera que la fuente quede inerte y devuelva [].\n");
  }

  console.log("Ejecutando adaptador 'freelancer' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  if (!env.FREELANCER_OAUTH_TOKEN) {
    if (result.items.length === 0) {
      console.log("OK: sin token, el adaptador devolvió [] sin lanzar error.");
    } else {
      throw new Error("Sin token la fuente debería devolver [], pero trajo items.");
    }
    return;
  }

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
  console.error("test-freelancer falló:", err);
  process.exit(1);
});

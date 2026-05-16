/**
 * Smoke test del adaptador de Workana.
 *
 * Corré con:  npx tsx scripts/test-workana.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 y el cursor resultante. No toca la base de datos: el config replica la fila
 * de `sources` con slug `workana`.
 *
 * Sin `SCRAPER_API_KEY` la fuente queda inerte: el script confirma que el
 * adaptador devuelve `[]` sin lanzar error. Con la key seteada, hace llamadas
 * reales al servicio de scraping (que es pago — cada corrida consume crédito).
 *
 * --- Re-ejecución ---
 * Los scripts sueltos no cargan `.env.local` por su cuenta. El import de
 * `./_reexec-with-env` —que va PRIMERO a propósito— re-ejecuta el script con
 * `--env-file=.env.local` para que `@/lib/env` valide contra el entorno real.
 * Ese import tiene que preceder a cualquier módulo que toque el entorno.
 */

// Re-ejecuta con `.env.local` cargado. Debe ir primero: los imports se evalúan
// en orden y `@/lib/env` valida el entorno apenas se importa.
import "./_reexec-with-env";

import { env } from "@/lib/env";
import { getSource } from "@/lib/sources";

/**
 * Config real de la fuente `workana` (espejo de la fila en `sources`).
 *
 * Cada entrada de `searchUrls` es una página de búsqueda de proyectos de
 * Workana. El adaptador la baja vía el servicio de scraping y parsea sus
 * listados.
 */
const CONFIG: { searchUrls: string[] } = {
  searchUrls: [
    "https://www.workana.com/jobs?category=it-programming&language=es",
    "https://www.workana.com/jobs?category=it-programming&language=en",
  ],
};

async function main(): Promise<void> {
  const adapter = getSource("workana");
  if (!adapter) {
    throw new Error("El adaptador 'workana' no está registrado en el registry");
  }

  const hasKey = Boolean(env.SCRAPER_API_KEY);
  if (!hasKey) {
    console.log("SCRAPER_API_KEY no está seteado.");
    console.log("Se espera que la fuente quede inerte y devuelva [].\n");
  } else {
    console.log("SCRAPER_API_KEY seteado: se harán llamadas reales (pagas).\n");
  }

  console.log("Ejecutando adaptador 'workana' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  if (!hasKey) {
    if (result.items.length === 0) {
      console.log(
        "OK: sin SCRAPER_API_KEY, el adaptador devolvió [] sin lanzar error.",
      );
    } else {
      throw new Error(
        "Sin SCRAPER_API_KEY la fuente debería devolver [], pero trajo items.",
      );
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
  const cursor = result.cursor as { lastSeenIds?: string[] };
  console.log(
    `\nCursor resultante: ${cursor.lastSeenIds?.length ?? 0} id(s) vistos.`,
  );
}

main().catch((err) => {
  console.error("test-workana falló:", err);
  process.exit(1);
});

/**
 * Smoke test del adaptador de Telegram.
 *
 * Corré con:  npx tsx scripts/test-telegram.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 y el cursor resultante. No toca la base de datos: el config replica la fila
 * semilla de `sources` con slug `telegram`.
 *
 * Sin las variables `TELEGRAM_*` la fuente queda inerte: el script confirma que
 * el adaptador devuelve `[]` sin lanzar error.
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

/** Config real de la fuente `telegram` (espejo de la fila semilla en `sources`). */
const CONFIG = {
  channels: ["tecnoempleo_remoto", "trabajositespana", "trabajosspain"],
};

function telegramConfigured(): boolean {
  return Boolean(
    env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH && env.TELEGRAM_SESSION,
  );
}

async function main(): Promise<void> {
  const adapter = getSource("telegram");
  if (!adapter) {
    throw new Error(
      "El adaptador 'telegram' no está registrado en el registry",
    );
  }

  const configured = telegramConfigured();
  if (!configured) {
    console.log("Variables TELEGRAM_* incompletas.");
    console.log("Se espera que la fuente quede inerte y devuelva [].\n");
  }

  console.log("Ejecutando adaptador 'telegram' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  if (!configured) {
    if (result.items.length === 0) {
      console.log(
        "OK: sin las TELEGRAM_*, el adaptador devolvió [] sin lanzar error.",
      );
    } else {
      throw new Error(
        "Sin las TELEGRAM_* la fuente debería devolver [], pero trajo items.",
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
  console.log(`\nCursor resultante: ${JSON.stringify(result.cursor)}`);
}

main().catch((err) => {
  console.error("test-telegram falló:", err);
  process.exit(1);
});

/**
 * Smoke test del adaptador de Discord.
 *
 * Corré con:  npx tsx scripts/test-discord-adapter.ts
 *
 * Ejecuta el adaptador con el config real de la fuente (cursor vacío, igual que
 * en la primera corrida de polling) e imprime cuántos items trajo, los primeros
 * 3 y el cursor resultante. No toca la base de datos: el config replica la fila
 * de `sources` con slug `discord`.
 *
 * Sin `DISCORD_BOT_TOKEN` la fuente queda inerte: el script confirma que el
 * adaptador devuelve `[]` sin lanzar error.
 *
 * Para probar contra canales reales, completá `CONFIG.channels` con los IDs del
 * setup manual de Discord (sección Discord del README, paso 32) — o copiá el
 * `config` de la fila `discord` de `sources` una vez que esté poblada.
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
 * Config real de la fuente `discord` (espejo de la fila en `sources`).
 *
 * Cada canal es `{ name, channelId, guildId }`. Mientras el setup manual de
 * Discord no esté completo la lista va vacía: el adaptador devuelve `[]`.
 */
const CONFIG: {
  channels: { name: string; channelId: string; guildId: string }[];
} = {
  channels: [],
};

async function main(): Promise<void> {
  const adapter = getSource("discord");
  if (!adapter) {
    throw new Error("El adaptador 'discord' no está registrado en el registry");
  }

  const hasToken = Boolean(env.DISCORD_BOT_TOKEN);
  if (!hasToken) {
    console.log("DISCORD_BOT_TOKEN no está seteado.");
    console.log("Se espera que la fuente quede inerte y devuelva [].\n");
  } else if (CONFIG.channels.length === 0) {
    console.log("Hay token pero CONFIG.channels está vacío.");
    console.log("Se espera una corrida vacía: [].\n");
  }

  console.log("Ejecutando adaptador 'discord' con cursor vacío…\n");
  const result = await adapter.fetchItems(CONFIG, {});

  console.log(`Items traídos: ${result.items.length}\n`);

  if (!hasToken) {
    if (result.items.length === 0) {
      console.log(
        "OK: sin DISCORD_BOT_TOKEN, el adaptador devolvió [] sin lanzar error.",
      );
    } else {
      throw new Error(
        "Sin DISCORD_BOT_TOKEN la fuente debería devolver [], pero trajo items.",
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
  console.error("test-discord-adapter falló:", err);
  process.exit(1);
});

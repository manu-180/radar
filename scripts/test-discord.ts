/**
 * Smoke test del bot de Discord.
 *
 * Corré con:  npx tsx scripts/test-discord.ts
 *
 * Verifica el SETUP MANUAL de Discord (ver la sección Discord del README), no el
 * adaptador —que llega en un paso posterior—. Con `DISCORD_BOT_TOKEN` seteado,
 * hace una llamada de prueba a la API REST de Discord (`GET /users/@me`) y
 * confirma que el token es válido y que el bot responde, imprimiendo su nombre e
 * ID. No toca la base de datos.
 *
 * Sin `DISCORD_BOT_TOKEN` el script no falla: avisa que el setup está pendiente
 * y termina con éxito (la fuente Discord queda inerte, igual que en producción).
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

/** Versión fija de la API REST de Discord (la que usará el adaptador). */
const DISCORD_API = "https://discord.com/api/v10";

/** Forma parcial de la respuesta de `GET /users/@me` para un bot. */
interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  bot?: boolean;
}

async function main(): Promise<void> {
  if (!env.DISCORD_BOT_TOKEN) {
    console.log("DISCORD_BOT_TOKEN no está seteado.");
    console.log(
      "El setup manual de Discord está pendiente (ver la sección Discord",
    );
    console.log(
      "del README). Sin el token, la fuente Discord queda inerte: [].",
    );
    return;
  }

  console.log("Llamando a Discord: GET /users/@me…\n");

  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: {
      // Discord exige el prefijo `Bot ` para tokens de bot.
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) {
      throw new Error(
        "Discord rechazó el token (401 Unauthorized). Revisá que " +
          "DISCORD_BOT_TOKEN sea el token del bot, sin comillas ni el prefijo " +
          "'Bot '.",
      );
    }
    throw new Error(
      `Discord respondió ${res.status} ${res.statusText}: ${body}`,
    );
  }

  const user = (await res.json()) as DiscordUser;

  console.log("─".repeat(60));
  console.log(`  id        : ${user.id}`);
  console.log(`  username  : ${user.username}#${user.discriminator}`);
  console.log(`  es bot    : ${user.bot ? "sí" : "no"}`);
  console.log("─".repeat(60));

  if (!user.bot) {
    throw new Error(
      "El token es válido pero NO corresponde a un bot. Usá el token del bot " +
        "de la aplicación, no un token de usuario.",
    );
  }

  console.log(
    `\nOK: el bot "${user.username}" responde y el token es válido.`,
  );
  console.log(
    "Próximo: invitarlo a los servidores objetivo y copiar los IDs de canal",
  );
  console.log("(ver la sección Discord del README).");
}

main().catch((err) => {
  console.error("test-discord falló:", err);
  process.exit(1);
});

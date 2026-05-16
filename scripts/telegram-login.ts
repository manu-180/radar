/**
 * Login interactivo del cliente de Telegram (MTProto).
 *
 * Corré con:  npx tsx scripts/telegram-login.ts
 *
 * Telegram no tiene una API HTTP simple para leer canales públicos: usa el
 * protocolo MTProto a través de la librería GramJS (paquete `telegram`), que
 * necesita una sesión de usuario autenticada. Esa sesión se genera UNA sola vez
 * de forma interactiva — eso es lo que hace este script.
 *
 * El flujo:
 *  1. Toma `api_id` / `api_hash` del entorno (`TELEGRAM_API_ID` /
 *     `TELEGRAM_API_HASH`) o, si faltan, los pide por la terminal. Se generan
 *     una vez en https://my.telegram.org (ver la sección Telegram del README).
 *  2. Pide el teléfono y el código que Telegram manda a la app (y la
 *     contraseña de verificación en dos pasos, si la cuenta la tiene).
 *  3. Al terminar imprime el `TELEGRAM_SESSION`: un string opaco que hay que
 *     copiar a `.env.local` y a Vercel. Con esas tres variables el adaptador
 *     de Telegram (paso 31) puede leer canales sin volver a autenticarse.
 *
 * El `TELEGRAM_SESSION` da acceso completo a la cuenta: tratalo como un
 * secreto y no lo subas al repo.
 *
 * --- Re-ejecución ---
 * Los scripts sueltos no cargan `.env.local` por su cuenta. Para poder tomar
 * `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` si ya están en ese archivo, en la
 * primera pasada el script se re-ejecuta a sí mismo con `--env-file=.env.local`
 * (solo si el archivo existe). La lógica real corre en ese proceso hijo.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// --- Re-ejecución: corre antes de cualquier otra cosa ---
if (!process.env.__TELEGRAM_LOGIN_CHILD && existsSync(".env.local")) {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, "--env-file=.env.local", ...process.argv.slice(1)],
    {
      stdio: "inherit",
      env: { ...process.env, __TELEGRAM_LOGIN_CHILD: "1" },
    },
  );
  process.exit(child.status ?? 1);
}

// --- A partir de acá: el entorno de `.env.local` ya está cargado (si existía) ---

async function main(): Promise<void> {
  console.log("─── Login del cliente de Telegram (MTProto / GramJS) ───\n");
  console.log(
    "Si todavía no tenés un api_id / api_hash, generalos en " +
      "https://my.telegram.org (ver la sección Telegram del README).\n",
  );

  // `api_id` / `api_hash`: del entorno si ya están, o se piden por terminal.
  const apiIdRaw =
    process.env.TELEGRAM_API_ID ?? (await input.text("TELEGRAM_API_ID:"));
  const apiHash =
    process.env.TELEGRAM_API_HASH ?? (await input.text("TELEGRAM_API_HASH:"));

  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new Error(
      `TELEGRAM_API_ID inválido: "${apiIdRaw}" — debe ser un entero positivo.`,
    );
  }
  if (apiHash.trim() === "") {
    throw new Error("TELEGRAM_API_HASH está vacío.");
  }

  // Sesión nueva y vacía: `client.start` la va a poblar al autenticarse.
  // Guardamos la referencia para leer el string final con `session.save()`.
  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () =>
      await input.text(
        "Teléfono en formato internacional (ej. +5491112345678):",
      ),
    phoneCode: async () =>
      await input.text("Código que te llegó por Telegram:"),
    // Solo se invoca si la cuenta tiene verificación en dos pasos activada.
    password: async () =>
      await input.password("Contraseña de verificación en dos pasos:"),
    onError: (err: Error) => {
      console.error("Error durante el login:", err.message);
    },
  });

  const sessionString = session.save();
  await client.disconnect();

  console.log("\n✓ Login completado.\n");
  console.log(
    "Copiá esta línea a `.env.local` y a Vercel (entorno Production),",
  );
  console.log("junto con TELEGRAM_API_ID y TELEGRAM_API_HASH:\n");
  console.log(`TELEGRAM_SESSION=${sessionString}`);
  console.log(
    "\n⚠️  Es un secreto: da acceso completo a la cuenta. No lo subas al repo.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\ntelegram-login falló:", err);
    process.exit(1);
  });

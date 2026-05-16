/**
 * Bootstrap de re-ejecución con `.env.local`.
 *
 * Un `npx tsx scripts/foo.ts` suelto NO carga `.env.local`: `process.env`
 * arranca sin las variables del archivo y cualquier módulo que valide el
 * entorno al importarse (`@/lib/env`) lanza de inmediato.
 *
 * Este módulo resuelve eso re-ejecutándose a sí mismo con la flag de Node
 * `--env-file=.env.local`. En el proceso padre: si no fue lanzado por este
 * bootstrap y `.env.local` existe, lo re-ejecuta —reusando `execArgv` y `argv`
 * para no perder el loader de tsx— y termina con el código de salida del hijo.
 * En el hijo (marcado con la variable centinela) es un no-op y el script sigue,
 * ya con el entorno de `.env.local` cargado.
 *
 * ## Importalo PRIMERO
 *
 * Los `import` de un módulo se evalúan en orden de aparición, y se hoistean por
 * encima de cualquier sentencia suelta. Por eso este bootstrap **debe ser el
 * primer import del script** — antes que `@/lib/env` o cualquier módulo que lo
 * arrastre. Si va después, `@/lib/env` ya validó (y explotó) en el proceso
 * padre antes de que el re-exec tenga la chance de correr.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Marca el proceso hijo para que el bootstrap no se vuelva a re-ejecutar. */
const SENTINEL = "__REEXEC_WITH_ENV_CHILD";

if (!process.env[SENTINEL] && existsSync(".env.local")) {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, "--env-file=.env.local", ...process.argv.slice(1)],
    {
      stdio: "inherit",
      env: { ...process.env, [SENTINEL]: "1" },
    },
  );
  process.exit(child.status ?? 1);
}

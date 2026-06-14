/**
 * Logger estructurado en líneas JSON.
 *
 * Mismo formato que el worker de Telegram (`worker/src/index.ts`): una línea
 * JSON por evento, con `level`, `msg`, `ts` y los campos extra que se pasen.
 * Railway agrega estas líneas a su stream de logs tal cual; un solo formato en
 * ambos workers hace que los logs sean parseables igual.
 */

export type LogLevel = "info" | "warn" | "error";

/** Emite una línea JSON al stream correspondiente al nivel. */
export function log(
  level: LogLevel,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...extra });
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

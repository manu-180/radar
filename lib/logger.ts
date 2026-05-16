/**
 * Logging estructurado compartido por todo Lead Detector.
 *
 * Cada llamada emite **una línea JSON** por `stdout`/`stderr`. Esto permite
 * filtrar los logs de Vercel por campos arbitrarios (ej. `runId`) para rastrear
 * una ejecución completa. Es un wrapper fino sobre `console`, sin dependencias.
 */

export type LogLevel = "info" | "warn" | "error";

/** Campos arbitrarios que se mezclan en la línea JSON del log. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  /** Evento informativo del flujo normal. */
  info(msg: string, fields?: LogFields): void;
  /** Situación anómala recuperable (ej. una fuente caída, se sigue). */
  warn(msg: string, fields?: LogFields): void;
  /** Fallo: algo no se pudo completar. */
  error(msg: string, fields?: LogFields): void;
  /** Devuelve un logger con `extra` agregado al contexto base. */
  child(extra: LogFields): Logger;
}

/**
 * Crea un logger. El `context` opcional se incluye en cada línea emitida; los
 * `fields` de cada llamada se mezclan encima de él. Usá {@link Logger.child}
 * para enlazar contexto adicional (ej. un `runId`) sin perder el de base.
 */
export function createLogger(context: LogFields = {}): Logger {
  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...context,
      ...fields,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  return {
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (extra) => createLogger({ ...context, ...extra }),
  };
}

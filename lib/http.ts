/**
 * Cliente HTTP robusto y compartido por todo Lead Detector.
 *
 * `fetchWithRetry` envuelve `fetch` con timeout por intento, reintentos con
 * backoff exponencial + jitter y respeto del header `Retry-After`. Todos los
 * adaptadores de fuentes y las rutas API deben usarlo en vez de llamar a
 * `fetch` directamente, para que el comportamiento ante fallos sea uniforme.
 */

/** Status HTTP que se consideran transitorios y disparan un reintento. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);

export interface FetchWithRetryOptions extends RequestInit {
  /** Timeout por intento, en ms. Default 15000. */
  timeoutMs?: number;
  /** Reintentos tras el primer intento. Default 3 (→ hasta 4 intentos). */
  retries?: number;
  /** Delay base del backoff exponencial, en ms. Default 500. */
  baseDelayMs?: number;
  /** Tope del delay entre reintentos, en ms. Default 20000. */
  maxDelayMs?: number;
  /** `User-Agent` a enviar. No pisa un header `User-Agent` ya presente. */
  userAgent?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parsea el header `Retry-After` a milisegundos. Acepta tanto un número de
 * segundos como una fecha HTTP. Devuelve `null` si el valor falta o no parsea.
 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Delay del reintento `attempt` (0-indexado): backoff exponencial con jitter completo. */
function backoffDelay(attempt: number, base: number, max: number): number {
  const exp = Math.min(base * 2 ** attempt, max);
  return Math.random() * exp;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Hace un `fetch` con timeout y reintentos.
 *
 * - Cada intento se corta a los `timeoutMs` mediante `AbortController`.
 * - Reintenta ante errores de red y ante status transitorios
 *   ({@link RETRYABLE_STATUS}), esperando `Retry-After` si el server lo manda
 *   o, en su defecto, un backoff exponencial con jitter.
 * - Devuelve la `Response` si el status es 2xx.
 * - Lanza un error descriptivo (con URL y último status/error) ante un status
 *   no recuperable o al agotar los reintentos.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 15_000,
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    userAgent,
    headers,
    signal: callerSignal,
    ...rest
  } = options;

  const mergedHeaders = new Headers(headers);
  if (userAgent && !mergedHeaders.has("user-agent")) {
    mergedHeaders.set("user-agent", userAgent);
  }

  let lastError: unknown;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort);

    let response: Response;
    try {
      response = await fetch(url, {
        ...rest,
        headers: mergedHeaders,
        signal: controller.signal,
      });
    } catch (err) {
      // Cancelación explícita del llamador: no es transitoria, no reintentar.
      if (callerSignal?.aborted) {
        throw new Error(
          `fetchWithRetry: request a ${url} cancelado por el llamador.`,
        );
      }
      lastError = timedOut
        ? new Error(`timeout tras ${timeoutMs} ms`)
        : err;
      if (attempt < retries) {
        await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (response.ok) return response;

    lastStatus = response.status;

    if (!RETRYABLE_STATUS.has(response.status)) {
      throw new Error(
        `fetchWithRetry: ${url} respondió ${response.status} ` +
          `${response.statusText} (status no recuperable).`,
      );
    }

    if (attempt < retries) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      await sleep(retryAfter ?? backoffDelay(attempt, baseDelayMs, maxDelayMs));
      continue;
    }
  }

  const reason =
    lastStatus !== undefined
      ? `último status ${lastStatus}`
      : `último error: ${describeError(lastError)}`;
  throw new Error(
    `fetchWithRetry: ${url} falló tras ${retries + 1} intento(s) (${reason}).`,
  );
}

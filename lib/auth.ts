/**
 * Sesión del dashboard: firma y verificación de la cookie `ld_session`.
 *
 * El dashboard es un panel personal de un solo usuario, así que la sesión no se
 * guarda en ninguna base: la cookie es autónoma y autovalidable. Su valor tiene
 * la forma `<emitidoEn>.<HMAC>`, donde `emitidoEn` es el instante de emisión
 * (ms desde epoch) y `HMAC` es su firma HMAC-SHA256 con `env.AUTH_SECRET`. Sin
 * la clave no se puede forjar un token válido; `emitidoEn` permite vencer la
 * sesión sin estado del lado del servidor.
 *
 * Estos helpers los comparten la server action de login y `proxy.ts`.
 */

import { createHmac } from "node:crypto";

import { env } from "@/lib/env";
import { timingSafeEqualStr } from "@/lib/security";

/** Nombre de la cookie de sesión del dashboard. */
export const SESSION_COOKIE = "ld_session";

/** Vida de la sesión: 30 días. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Margen de tolerancia para desfasajes de reloj al validar `emitidoEn`. */
const CLOCK_SKEW_MS = 60 * 1000;

/** Firma HMAC-SHA256 de `emitidoEn` (base64url), con `env.AUTH_SECRET`. */
function sign(issuedAt: number): string {
  return createHmac("sha256", env.AUTH_SECRET)
    .update(String(issuedAt))
    .digest("base64url");
}

/**
 * Crea el valor de la cookie de sesión para una sesión emitida en `issuedAt`
 * (por defecto, ahora). Formato: `<emitidoEn>.<HMAC>`.
 */
export function createSessionToken(issuedAt: number = Date.now()): string {
  return `${issuedAt}.${sign(issuedAt)}`;
}

/**
 * Verifica un valor de cookie de sesión. Devuelve `true` solo si el token está
 * bien formado, su HMAC es válido (comparado en tiempo constante) y no venció.
 * Acepta `undefined` para poder pasarle directamente `cookie?.value`.
 */
export function isValidSessionToken(token: string | undefined): boolean {
  if (!token) return false;

  // El HMAC en base64url no contiene puntos y `emitidoEn` es solo dígitos, así
  // que el primer `.` separa ambas partes sin ambigüedad.
  const sep = token.indexOf(".");
  if (sep <= 0 || sep === token.length - 1) return false;

  const issuedAtRaw = token.slice(0, sep);
  const providedHmac = token.slice(sep + 1);

  // `emitidoEn` debe ser un entero positivo canónico (sin ceros a la izquierda)
  // para que cada instante tenga una sola codificación posible.
  if (!/^[1-9][0-9]*$/.test(issuedAtRaw)) return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt)) return false;

  // Comparación en tiempo constante: no filtra el HMAC esperado.
  if (!timingSafeEqualStr(providedHmac, sign(issuedAt))) return false;

  // Vigencia: ni vencida ni emitida en el futuro (con margen de clock skew).
  const now = Date.now();
  if (issuedAt > now + CLOCK_SKEW_MS) return false;
  if (now - issuedAt > SESSION_MAX_AGE_MS) return false;

  return true;
}

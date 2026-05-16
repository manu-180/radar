/**
 * Utilidades de seguridad compartidas.
 *
 * Centraliza la comparación de secretos en tiempo constante para que las rutas
 * de cron y los webhooks no reimplementen verificaciones vulnerables a ataques
 * de timing.
 */

import { timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";

/**
 * Compara dos strings en tiempo constante respecto del **contenido**.
 *
 * `crypto.timingSafeEqual` exige buffers de igual longitud, así que siempre lo
 * invocamos con dos buffers del mismo largo y devolvemos `false` aparte si las
 * longitudes difieren. La diferencia de longitud sí puede inferirse por timing,
 * pero eso es inevitable y no revela el contenido del secreto.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const sameLength = bufA.length === bufB.length;
  // Si las longitudes no coinciden comparamos `bufA` contra sí mismo: la
  // comparación se ejecuta igual (tiempo constante) pero el resultado se
  // descarta vía `sameLength`.
  const reference = sameLength ? bufB : bufA;
  const equal = timingSafeEqual(bufA, reference);
  return sameLength && equal;
}

/**
 * Verifica que un request traiga el header `x-cron-secret` correcto.
 *
 * Pensado para proteger las rutas disparadas por cron. Compara el header de
 * forma timing-safe contra `env.CRON_SECRET`.
 */
export function verifyCronSecret(request: Request): boolean {
  const provided = request.headers.get("x-cron-secret");
  if (!provided) return false;
  return timingSafeEqualStr(provided, env.CRON_SECRET);
}

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

/**
 * Verifica que un request traiga el secreto de webhook correcto.
 *
 * Protege los webhooks entrantes de los canales (`/api/inbound/*`). Acepta el
 * secreto por dos vías, en orden de preferencia:
 *  1. Header `x-webhook-secret` (lo usa el worker de Telegram, que controlamos).
 *  2. Query param `?s=` o `?secret=` (fallback): algunos proveedores de webhook
 *     —Evolution API entre ellos— no permiten mandar headers custom, así que el
 *     secreto va en la URL del webhook. Viaja sobre HTTPS.
 *
 * Si `WEBHOOK_SECRET` no está configurado, devuelve `false` siempre: sin secreto,
 * los webhooks quedan cerrados y el outreach automático no recibe nada (modo
 * seguro por defecto). La comparación es timing-safe en ambas vías.
 */
export function verifyWebhookSecret(request: Request): boolean {
  const secret = env.WEBHOOK_SECRET;
  if (!secret) return false;

  // 1) Header preferido.
  const header = request.headers.get("x-webhook-secret");
  if (header) return timingSafeEqualStr(header, secret);

  // 2) Fallback por query param (proveedores sin headers custom).
  try {
    const fromQuery =
      new URL(request.url).searchParams.get("s") ??
      new URL(request.url).searchParams.get("secret");
    if (fromQuery) return timingSafeEqualStr(fromQuery, secret);
  } catch {
    // request.url malformado: cae al `false` de abajo.
  }

  return false;
}

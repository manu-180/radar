/**
 * Proxy de autenticación del dashboard.
 *
 * En Next.js 16 el archivo `middleware` quedó deprecado y se renombró a
 * `proxy`: este archivo cumple ese rol. Corre antes de resolver cualquier ruta
 * y exige una sesión válida para todo lo que no sea público. Sin una cookie
 * `ld_session` con HMAC válido y vigente, redirige a `/login`.
 *
 * Es una verificación optimista: solo lee y valida la cookie firmada, sin
 * tocar la base de datos.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

/** Rutas accesibles sin sesión. Todo lo demás se considera dashboard. */
const PUBLIC_PATHS = new Set(["/", "/login"]);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const hasSession = isValidSessionToken(
    request.cookies.get(SESSION_COOKIE)?.value,
  );

  // Quien ya tiene sesión no necesita volver a /login.
  if (pathname === "/login" && hasSession) {
    return NextResponse.redirect(new URL("/overview", request.url));
  }

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // Ruta del dashboard sin sesión válida → al login.
  if (!hasSession) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

/**
 * Corre en todas las rutas salvo `/api/*`, los assets internos de Next y el
 * favicon. La exclusión de `/login` se maneja dentro de `proxy` (vía
 * `PUBLIC_PATHS`), para poder además sacar del login a quien ya está logueado.
 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};

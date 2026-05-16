"use server";

/**
 * Server action de acceso al dashboard.
 *
 * Compara la contraseña enviada contra `env.DASHBOARD_PASSWORD` en tiempo
 * constante. Si coincide, emite la cookie de sesión `ld_session` y redirige al
 * panel. Si no, espera ~1 s antes de responder: esa demora —sumada a la
 * comparación timing-safe— encarece la fuerza bruta sobre el único secreto que
 * protege el panel.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  createSessionToken,
} from "@/lib/auth";
import { env } from "@/lib/env";
import { timingSafeEqualStr } from "@/lib/security";

/** Estado que la server action devuelve al formulario vía `useActionState`. */
export type LoginState = { error?: string };

/** Demora aplicada ante un intento fallido, en milisegundos. */
const FAILED_ATTEMPT_DELAY_MS = 1000;

export async function login(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const password = formData.get("password");

  if (
    typeof password === "string" &&
    timingSafeEqualStr(password, env.DASHBOARD_PASSWORD)
  ) {
    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE, createSessionToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    });
    // `redirect` lanza una excepción de control: nada debajo se ejecuta.
    redirect("/leads");
  }

  await new Promise((resolve) => setTimeout(resolve, FAILED_ATTEMPT_DELAY_MS));
  return { error: "Contraseña incorrecta." };
}

"use server";

/**
 * Server actions del dashboard.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE } from "@/lib/auth";

/** Cierra la sesión: borra la cookie `ld_session` y vuelve al login. */
export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/login");
}

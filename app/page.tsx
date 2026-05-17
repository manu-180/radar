import { redirect } from "next/navigation";

/**
 * Raíz del sitio.
 *
 * No tiene contenido propio: la única vista para humanos es el dashboard, así
 * que la raíz manda directo al listado de leads. Si no hay sesión, `proxy.ts`
 * intercepta `/leads` y redirige al login. (El endpoint de salud que consulta
 * el monitor de uptime es `/api/health`, no la raíz.)
 */
export default function Home(): never {
  redirect("/leads");
}

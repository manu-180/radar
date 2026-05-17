/**
 * Dispatcher de polling.
 *
 * `POST /api/cron/dispatch` es el único endpoint que invoca el cron externo.
 * Lee las fuentes habilitadas y dispara una corrida `/api/poll/<slug>` por cada
 * una, en paralelo.
 *
 * Responde de inmediato: el fan-out se hace en `after()`, ya enviada la
 * respuesta, para no atar el cron al tiempo de los polls. Cada poll corre como
 * su propia invocación, con su propio presupuesto y aislamiento de fallas — una
 * fuente caída no afecta a las demás ni a este dispatcher.
 *
 * Está protegido por el header `x-cron-secret`.
 */

import { after } from "next/server";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { getAdminClient } from "@/lib/supabase/admin";

/** El dispatcher se ejecuta siempre, sin caché. */
export const dynamic = "force-dynamic";
/**
 * El fan-out en `after()` espera a que cada `/api/poll/<slug>` termine (cada
 * uno con su presupuesto de 300 s): el dispatcher necesita el mismo techo para
 * no cortar ese `after()` antes de tiempo.
 */
export const maxDuration = 300;

const log = createLogger({ route: "dispatch" });

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }

  const { data, error } = await getAdminClient()
    .from("sources")
    .select("slug")
    .eq("enabled", true);

  if (error) {
    log.error("No se pudieron leer las fuentes habilitadas", { error: error.message });
    return Response.json(
      { error: `No se pudieron leer las fuentes: ${error.message}` },
      { status: 500 },
    );
  }

  const slugs = (data ?? []).map((row) => row.slug as string);
  log.info("Fuentes habilitadas a sondear", { count: slugs.length, slugs });

  // Fan-out tras la respuesta: una invocación de `/api/poll/<slug>` por fuente.
  after(async () => {
    const results = await Promise.allSettled(
      slugs.map(async (slug) => {
        const response = await fetch(`${env.APP_URL}/api/poll/${slug}`, {
          method: "POST",
          headers: { "x-cron-secret": env.CRON_SECRET },
        });
        if (!response.ok) {
          throw new Error(`poll respondió ${response.status} ${response.statusText}`);
        }
        return slug;
      }),
    );

    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        log.info("Poll disparado", { source: slugs[i] });
      } else {
        log.error("No se pudo disparar el poll", {
          source: slugs[i],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
      }
    });
  });

  return Response.json({ ok: true, dispatched: slugs.length, sources: slugs });
}

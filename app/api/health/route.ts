/**
 * Ruta de estado del sistema.
 *
 * `GET /api/health` es el endpoint que consulta un monitor de uptime externo.
 * Tiene dos modos de respuesta según quién pregunta:
 *
 *  - **Pública (sin secreto)**: solo `{ status }`. Un endpoint de health abierto
 *    no debe filtrar el estado interno —counts, errores, backlog—, así que la
 *    salida pública es deliberadamente mínima.
 *  - **Detallada (con secreto)**: si la request trae el `CRON_SECRET` correcto
 *    (header `x-cron-secret` o query `?token=`, comparado en tiempo constante),
 *    devuelve además el desglose: último run exitoso por tipo, backlog de leads,
 *    runs con error en las últimas 24 h y notificaciones fallidas recientes.
 *
 * El `status` global se deriva del estado real y se incluye en ambos modos:
 *  - `down`     — no hubo un poll exitoso en mucho tiempo (el sistema no mira).
 *  - `degraded` — hay runs con error, notificaciones fallidas o backlog viejo.
 *  - `ok`       — todo sano.
 *
 * Si el propio chequeo no puede leer la base, se reporta `down`: ante estado
 * desconocido, lo conservador para un monitor es asumir lo peor.
 */

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { timingSafeEqualStr } from "@/lib/security";
import { getAdminClient } from "@/lib/supabase/admin";

/** El estado se evalúa siempre en vivo, sin caché. */
export const dynamic = "force-dynamic";

const log = createLogger({ route: "health" });

/** Una hora en ms; ventana base para los umbrales. */
const HOUR_MS = 60 * 60 * 1000;
/** Ventana de 24 h para runs con error y notificaciones fallidas. */
const DAY_MS = 24 * HOUR_MS;
/** Sin un poll exitoso en este lapso, el sistema se considera caído. */
const POLL_DOWN_AFTER_MS = HOUR_MS;
/** Un lead `pending` más viejo que esto delata un backlog estancado. */
const BACKLOG_STALE_AFTER_MS = 30 * 60 * 1000;

/** Tipos de run que se reportan en el desglose. */
type ReportedKind = "poll" | "process" | "notify";

/** Estado global del sistema. */
type HealthStatus = "ok" | "degraded" | "down";

/** Último run exitoso de un tipo: cuándo terminó y hace cuánto. */
interface LastRun {
  finishedAt: string;
  ageSeconds: number;
}

/** Run que terminó con error dentro de la ventana de 24 h. */
interface ErroredRun {
  id: number;
  kind: string;
  source: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** Notificación que falló dentro de la ventana de 24 h. */
interface FailedNotification {
  id: number;
  leadId: number | null;
  createdAt: string;
  error: string | null;
}

/** Foto completa del estado interno; base tanto del `status` como del detalle. */
interface HealthData {
  lastSuccessfulRun: Record<ReportedKind, LastRun | null>;
  pendingLeads: { count: number; oldestAgeSeconds: number | null };
  erroredRuns: ErroredRun[];
  failedNotifications: FailedNotification[];
}

/** Edad en segundos (≥ 0) de un timestamp ISO respecto de `now`. */
function ageSecondsSince(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
}

/**
 * ¿La request está autorizada a ver el detalle?
 *
 * El secreto puede venir por el header `x-cron-secret` o por la query `?token=`;
 * en ambos casos se compara en tiempo constante contra `env.CRON_SECRET`. Si no
 * viene por ningún lado, la respuesta queda en modo público.
 */
function isAuthorized(request: Request): boolean {
  const provided =
    request.headers.get("x-cron-secret") ??
    new URL(request.url).searchParams.get("token");
  if (!provided) return false;
  return timingSafeEqualStr(provided, env.CRON_SECRET);
}

/** Último run exitoso de un `kind`, o `null` si nunca hubo uno. */
async function loadLastSuccessfulRun(
  db: ReturnType<typeof getAdminClient>,
  kind: ReportedKind,
  now: number,
): Promise<LastRun | null> {
  const { data, error } = await db
    .from("runs")
    .select("finished_at")
    .eq("kind", kind)
    .eq("status", "ok")
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`No se pudo leer el último run de '${kind}': ${error.message}`);
  }
  if (!data?.finished_at) return null;

  const finishedAt = data.finished_at as string;
  return { finishedAt, ageSeconds: ageSecondsSince(finishedAt, now) };
}

/** Cantidad de leads sin clasificar y antigüedad del más viejo. */
async function loadPendingLeads(
  db: ReturnType<typeof getAdminClient>,
  now: number,
): Promise<HealthData["pendingLeads"]> {
  const { count, error: countErr } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("llm_status", "pending");
  if (countErr) {
    throw new Error(`No se pudieron contar los leads pendientes: ${countErr.message}`);
  }

  const { data, error } = await db
    .from("leads")
    .select("first_seen_at")
    .eq("llm_status", "pending")
    .order("first_seen_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`No se pudo leer el lead pendiente más viejo: ${error.message}`);
  }

  return {
    count: count ?? 0,
    oldestAgeSeconds: data?.first_seen_at
      ? ageSecondsSince(data.first_seen_at as string, now)
      : null,
  };
}

/** Runs que terminaron con error desde `since` (ISO). */
async function loadErroredRuns(
  db: ReturnType<typeof getAdminClient>,
  since: string,
): Promise<ErroredRun[]> {
  const { data, error } = await db
    .from("runs")
    .select("id, kind, source, started_at, finished_at, error")
    .eq("status", "error")
    .gte("started_at", since)
    .order("started_at", { ascending: false });
  if (error) {
    throw new Error(`No se pudieron leer los runs con error: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    id: row.id as number,
    kind: row.kind as string,
    source: (row.source as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  }));
}

/** Notificaciones fallidas desde `since` (ISO). */
async function loadFailedNotifications(
  db: ReturnType<typeof getAdminClient>,
  since: string,
): Promise<FailedNotification[]> {
  const { data, error } = await db
    .from("notifications")
    .select("id, lead_id, created_at, error")
    .eq("status", "failed")
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(
      `No se pudieron leer las notificaciones fallidas: ${error.message}`,
    );
  }

  return (data ?? []).map((row) => ({
    id: row.id as number,
    leadId: (row.lead_id as number | null) ?? null,
    createdAt: row.created_at as string,
    error: (row.error as string | null) ?? null,
  }));
}

/** Reúne toda la foto del estado interno con las consultas en paralelo. */
async function collectHealth(
  db: ReturnType<typeof getAdminClient>,
  now: number,
): Promise<HealthData> {
  const since24h = new Date(now - DAY_MS).toISOString();

  const [poll, process, notify, pendingLeads, erroredRuns, failedNotifications] =
    await Promise.all([
      loadLastSuccessfulRun(db, "poll", now),
      loadLastSuccessfulRun(db, "process", now),
      loadLastSuccessfulRun(db, "notify", now),
      loadPendingLeads(db, now),
      loadErroredRuns(db, since24h),
      loadFailedNotifications(db, since24h),
    ]);

  return {
    lastSuccessfulRun: { poll, process, notify },
    pendingLeads,
    erroredRuns,
    failedNotifications,
  };
}

/** Deriva el `status` global a partir de la foto del estado interno. */
function deriveStatus(data: HealthData): HealthStatus {
  // `down`: el polling es el latido del sistema. Si no hubo un poll exitoso
  // reciente, no estamos mirando ninguna plataforma.
  const lastPoll = data.lastSuccessfulRun.poll;
  if (!lastPoll || lastPoll.ageSeconds * 1000 > POLL_DOWN_AFTER_MS) {
    return "down";
  }

  // `degraded`: el sistema mira, pero algo se está acumulando o fallando.
  const hasErroredRuns = data.erroredRuns.length > 0;
  const hasFailedNotifications = data.failedNotifications.length > 0;
  const staleBacklog =
    data.pendingLeads.oldestAgeSeconds !== null &&
    data.pendingLeads.oldestAgeSeconds * 1000 > BACKLOG_STALE_AFTER_MS;
  if (hasErroredRuns || hasFailedNotifications || staleBacklog) {
    return "degraded";
  }

  return "ok";
}

/** Código HTTP del estado: `down` mapea a 503 para que un monitor simple alerte. */
function httpStatusFor(status: HealthStatus): number {
  return status === "down" ? 503 : 200;
}

export async function GET(request: Request): Promise<Response> {
  const authorized = isAuthorized(request);
  const now = Date.now();

  let data: HealthData;
  try {
    data = await collectHealth(getAdminClient(), now);
  } catch (err) {
    // Si no podemos leer el estado, lo desconocemos: para un monitor, `down`.
    const message = err instanceof Error ? err.message : String(err);
    log.error("No se pudo evaluar el estado del sistema", { error: message });
    return Response.json(
      authorized ? { status: "down", error: message } : { status: "down" },
      { status: 503 },
    );
  }

  const status = deriveStatus(data);

  // Modo público: solo el estado, sin filtrar nada interno.
  if (!authorized) {
    return Response.json({ status }, { status: httpStatusFor(status) });
  }

  // Modo detallado: el desglose completo para diagnóstico.
  return Response.json(
    {
      status,
      checkedAt: new Date(now).toISOString(),
      lastSuccessfulRun: data.lastSuccessfulRun,
      pendingLeads: data.pendingLeads,
      erroredRunsLast24h: {
        count: data.erroredRuns.length,
        runs: data.erroredRuns,
      },
      failedNotificationsLast24h: {
        count: data.failedNotifications.length,
        notifications: data.failedNotifications,
      },
    },
    { status: httpStatusFor(status) },
  );
}

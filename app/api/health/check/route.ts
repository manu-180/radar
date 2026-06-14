/**
 * Ruta de chequeo activo de salud — el "monitoreo del monitor".
 *
 * `POST /api/health/check` no devuelve estado para que alguien lo mire: lo
 * evalúa y, si algo está roto, le manda un WhatsApp al dueño. La dispara el
 * cron cada hora; está protegida por el header `x-cron-secret`.
 *
 * A diferencia de `GET /api/health` —pensado para un monitor externo que sólo
 * sabe leer un código HTTP—, este endpoint conoce las reglas del negocio y
 * detecta fallas *parciales*: el sistema responde pero dejó de sondear, una
 * fuente viene fallando, la cola de IA se estancó, los avisos no salen, o el
 * propio cron de Postgres está fallando.
 *
 * Anti-spam: sin memoria, una falla persistente dispararía un WhatsApp por
 * hora. Se guarda en `settings` (`health_last_alert`) la *firma* del problema
 * y cuándo se avisó; sólo se vuelve a avisar si la firma cambió (problema
 * nuevo) o si pasó el cooldown (recordatorio de que sigue roto). Al volver a
 * la normalidad se avisa "recuperado" una sola vez y se limpia la firma.
 */

import { finishRun, startRun } from "@/lib/db/runs";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { sendWhatsApp } from "@/lib/notify/evolution";
import { verifyCronSecret } from "@/lib/security";
import { getAdminClient } from "@/lib/supabase/admin";

/** El chequeo se evalúa siempre en vivo, sin caché. */
export const dynamic = "force-dynamic";
/** Varias consultas más, como mucho, un envío de WhatsApp: con 60 s sobra. */
export const maxDuration = 60;

const log = createLogger({ route: "health/check" });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Sin un poll exitoso en esta ventana, el sistema dejó de mirar. */
const POLL_STALE_AFTER_MS = 90 * MINUTE_MS;
/** Polls fallidos seguidos que marcan una fuente como caída. */
const SOURCE_DOWN_STREAK = 3;
/** Un lead `pending` más viejo que esto delata un backlog de IA estancado. */
const BACKLOG_STALE_AFTER_MS = 2 * HOUR_MS;
/** Un lead atascado en un estado intermedio más que esto delata un reclamo sin reciclar. */
const STUCK_LEAD_AFTER_MS = 45 * MINUTE_MS;
/** Ventana para considerar "reciente" un fallo del cron de Postgres. */
const CRON_FAILURE_WINDOW_MIN = 90;
/** Cooldown entre dos avisos del *mismo* problema (recordatorio). */
const ALERT_COOLDOWN_MS = 6 * HOUR_MS;

/** Clave de `settings` donde vive la firma del último problema avisado. */
const ALERT_STATE_KEY = "health_last_alert";

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** Un problema detectado: `key` arma la firma; `summary` va al WhatsApp. */
interface Problem {
  /** Identificador estable del problema; entra en la firma anti-spam. */
  key: string;
  /** Descripción legible para el aviso. */
  summary: string;
}

type Db = ReturnType<typeof getAdminClient>;

/** Estado anti-spam persistido en `settings`. */
interface AlertState {
  /** Firma del conjunto de problemas avisado por última vez. */
  signature: string;
  /** ISO del último aviso efectivamente enviado. */
  alertedAt: string;
}

// ── Reglas de chequeo ───────────────────────────────────────────────────────
// Cada regla devuelve 0..N `Problem`. No lanzan por un problema *detectado*;
// sí lanzan si la consulta misma falla (eso vuelve la corrida `error`).

/** ¿Hubo algún poll exitoso en los últimos 90 min? */
async function checkPolling(db: Db, now: number): Promise<Problem[]> {
  const since = new Date(now - POLL_STALE_AFTER_MS).toISOString();
  const { count, error } = await db
    .from("runs")
    .select("id", { count: "exact", head: true })
    .eq("kind", "poll")
    .eq("status", "ok")
    .gte("finished_at", since);
  if (error) {
    throw new Error(`No se pudieron contar los polls recientes: ${error.message}`);
  }
  if ((count ?? 0) > 0) return [];
  return [
    {
      key: "no-polling",
      summary: "No hubo ningún poll exitoso en los últimos 90 min.",
    },
  ];
}

/** ¿Alguna fuente acumula 3+ polls fallidos consecutivos? */
async function checkSources(db: Db): Promise<Problem[]> {
  // Sólo una fuente *habilitada* puede estar "caída": una deshabilitada está
  // apagada a propósito (ej. sin credenciales), no rota. Sin este filtro, una
  // fuente apagada que venía fallando quedaría marcada para siempre —nunca
  // vuelve a tener un `ok` que corte la racha— y dispararía recordatorios.
  const { data: enabledRows, error: enabledErr } = await db
    .from("sources")
    .select("slug")
    .eq("enabled", true);
  if (enabledErr) {
    throw new Error(`No se pudieron leer las fuentes habilitadas: ${enabledErr.message}`);
  }
  const enabled = new Set((enabledRows ?? []).map((r) => r.slug as string));

  // Las corridas terminadas (ok/error) de poll, de la más nueva a la más vieja.
  // Una corrida `running` aún no tiene veredicto: se excluye.
  const { data, error } = await db
    .from("runs")
    .select("source, status, started_at")
    .eq("kind", "poll")
    .in("status", ["ok", "error"])
    .order("started_at", { ascending: false })
    .limit(500);
  if (error) {
    throw new Error(`No se pudieron leer los runs de poll: ${error.message}`);
  }

  // Por fuente, contar la racha de errores *desde la corrida más reciente*.
  // En cuanto aparece un `ok`, la racha se corta para esa fuente.
  const streak = new Map<string, number>();
  const broken = new Set<string>();
  for (const row of data ?? []) {
    const source = (row.source as string | null) ?? "(desconocida)";
    if (broken.has(source)) continue;
    if (row.status === "ok") {
      broken.add(source); // racha cortada: no mirar runs más viejos
      continue;
    }
    const next = (streak.get(source) ?? 0) + 1;
    streak.set(source, next);
  }

  const problems: Problem[] = [];
  for (const [source, count] of streak) {
    if (count >= SOURCE_DOWN_STREAK && enabled.has(source)) {
      problems.push({
        key: `source-down:${source}`,
        summary: `Fuente "${source}": ${count} polls fallidos seguidos.`,
      });
    }
  }
  return problems;
}

/** ¿Hay leads `pending` esperando a la IA hace más de 2 h? */
async function checkBacklog(db: Db, now: number): Promise<Problem[]> {
  // Si la clasificación está pausada a propósito (se alcanzó el tope de costo de
  // la IA), un backlog de `pending` es esperado, no una falla: no se alerta.
  const { data: pausedRow } = await db
    .from("settings")
    .select("value")
    .eq("key", "classifier_paused")
    .maybeSingle();
  if (pausedRow?.value === true) return [];

  const since = new Date(now - BACKLOG_STALE_AFTER_MS).toISOString();
  const { count, error } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("llm_status", "pending")
    .lt("first_seen_at", since);
  if (error) {
    throw new Error(`No se pudo contar el backlog de IA: ${error.message}`);
  }
  if ((count ?? 0) === 0) return [];
  return [
    {
      key: "ai-backlog",
      summary: `${count} lead(s) pendientes de clasificar hace más de 2 h.`,
    },
  ];
}

/** ¿Hay leads con la notificación fallida sin resolver? */
async function checkNotifications(db: Db): Promise<Problem[]> {
  const { count, error } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("notify_status", "failed");
  if (error) {
    throw new Error(`No se pudieron contar las notificaciones fallidas: ${error.message}`);
  }
  if ((count ?? 0) === 0) return [];
  return [
    {
      key: "notify-failed",
      summary: `${count} lead(s) con la notificación de WhatsApp fallida.`,
    },
  ];
}

/**
 * ¿Hay leads atascados en un estado intermedio?
 *
 * Un lead en `processing` (clasificación) o `sending` (notificación) cuyo
 * `claimed_at` quedó más viejo que {@link STUCK_LEAD_AFTER_MS} delata que el
 * reclamo resiliente no lo recicló — típicamente porque la etapa que debía
 * re-tomarlo (`/api/process` o `/api/notify`) dejó de correr. El reclamo normal
 * recicla a los 15 min, así que pasados 45 min ya es una anomalía real.
 *
 * Tolerante a un esquema viejo: si la columna `claimed_at` todavía no existe
 * (migración 0007 sin aplicar) la consulta falla; en vez de tumbar el chequeo
 * entero se loguea y se devuelve sin problema detectado.
 */
async function checkStuckLeads(db: Db, now: number): Promise<Problem[]> {
  const since = new Date(now - STUCK_LEAD_AFTER_MS).toISOString();
  const { count, error } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .or("llm_status.eq.processing,notify_status.eq.sending")
    .lt("claimed_at", since);
  if (error) {
    log.warn(
      "No se pudo evaluar los leads atascados (¿migración 0007 pendiente?)",
      { error: error.message },
    );
    return [];
  }
  if ((count ?? 0) === 0) return [];
  return [
    {
      key: "stuck-leads",
      summary: `${count} lead(s) atascados en un estado intermedio hace más de 45 min.`,
    },
  ];
}

/** ¿El cron de Postgres tuvo corridas fallidas recientes? */
async function checkCron(db: Db): Promise<Problem[]> {
  const { data, error } = await db.rpc("health_cron_failures", {
    since_minutes: CRON_FAILURE_WINDOW_MIN,
  });
  if (error) {
    throw new Error(`No se pudo leer el estado del cron: ${error.message}`);
  }

  const rows = (data ?? []) as { jobname: string }[];
  if (rows.length === 0) return [];

  const jobs = [...new Set(rows.map((r) => r.jobname))].join(", ");
  return [
    {
      key: "cron-failed",
      summary: `El cron de Postgres falló ${rows.length} vez/veces (jobs: ${jobs}).`,
    },
  ];
}

/** Corre las seis reglas en paralelo y junta todos los problemas. */
async function collectProblems(db: Db, now: number): Promise<Problem[]> {
  const groups = await Promise.all([
    checkPolling(db, now),
    checkSources(db),
    checkBacklog(db, now),
    checkNotifications(db),
    checkCron(db),
    checkStuckLeads(db, now),
  ]);
  return groups.flat();
}

// ── Anti-spam ───────────────────────────────────────────────────────────────

/**
 * Firma del estado: las claves de los problemas, ordenadas. Dos corridas con
 * los mismos problemas producen la misma firma; si aparece o se va uno, cambia.
 */
function signatureOf(problems: Problem[]): string {
  return problems
    .map((p) => p.key)
    .sort()
    .join("|");
}

/** Lee el estado anti-spam de `settings`, o `null` si no hay alerta activa. */
async function loadAlertState(db: Db): Promise<AlertState | null> {
  const { data, error } = await db
    .from("settings")
    .select("value")
    .eq("key", ALERT_STATE_KEY)
    .maybeSingle();
  if (error) {
    throw new Error(`No se pudo leer ${ALERT_STATE_KEY}: ${error.message}`);
  }

  const value = data?.value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as AlertState).signature === "string" &&
    typeof (value as AlertState).alertedAt === "string"
  ) {
    return value as AlertState;
  }
  return null;
}

/** Persiste la firma del problema recién avisado. */
async function saveAlertState(db: Db, state: AlertState): Promise<void> {
  const { error } = await db
    .from("settings")
    .upsert(
      { key: ALERT_STATE_KEY, value: state, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (error) {
    throw new Error(`No se pudo guardar ${ALERT_STATE_KEY}: ${error.message}`);
  }
}

/** Limpia la firma: el sistema volvió a la normalidad. */
async function clearAlertState(db: Db): Promise<void> {
  const { error } = await db.from("settings").delete().eq("key", ALERT_STATE_KEY);
  if (error) {
    throw new Error(`No se pudo limpiar ${ALERT_STATE_KEY}: ${error.message}`);
  }
}

/** Arma el texto del WhatsApp de alerta. */
function buildAlertMessage(problems: Problem[]): string {
  const lines = problems.map((p) => `• ${p.summary}`);
  return [
    "🚨 *Lead Detector* — alerta de salud",
    "",
    "El monitoreo detectó problemas:",
    ...lines,
    "",
    "Revisá el sistema cuando puedas.",
  ].join("\n");
}

/** Arma el texto del WhatsApp de recuperación. */
function buildRecoveryMessage(): string {
  return [
    "✅ *Lead Detector* — recuperado",
    "",
    "Los problemas detectados antes ya no aparecen: el sistema volvió a la normalidad.",
  ].join("\n");
}

/** Qué hizo la corrida respecto del aviso, para el log y la respuesta. */
type AlertOutcome = "alert-sent" | "recovery-sent" | "suppressed" | "none";

/**
 * Decide y ejecuta el aviso según los problemas y el estado anterior.
 *
 * - Sin problemas y había una alerta activa → avisa "recuperado" y limpia.
 * - Con problemas → avisa si la firma cambió (problema nuevo) o si venció el
 *   cooldown (recordatorio); si no, lo suprime para no spamear.
 */
async function reconcileAlert(
  db: Db,
  problems: Problem[],
  now: number,
  runLog: ReturnType<typeof createLogger>,
): Promise<AlertOutcome> {
  const prev = await loadAlertState(db);

  if (problems.length === 0) {
    if (!prev) return "none";
    await sendWhatsApp(env.OWNER_WHATSAPP, buildRecoveryMessage());
    await clearAlertState(db);
    runLog.info("Aviso de recuperación enviado");
    return "recovery-sent";
  }

  const signature = signatureOf(problems);
  const changed = !prev || prev.signature !== signature;
  const cooldownElapsed =
    !prev || now - Date.parse(prev.alertedAt) >= ALERT_COOLDOWN_MS;

  if (!changed && !cooldownElapsed) {
    runLog.info("Alerta suprimida por anti-spam", { signature });
    return "suppressed";
  }

  await sendWhatsApp(env.OWNER_WHATSAPP, buildAlertMessage(problems));
  await saveAlertState(db, { signature, alertedAt: new Date(now).toISOString() });
  runLog.info("Aviso de alerta enviado", { signature, changed, cooldownElapsed });
  return "alert-sent";
}

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const db = getAdminClient();
  const now = Date.now();

  const runId = await startRun("health");
  const runLog = log.child({ runId });
  runLog.info("Chequeo de salud iniciado");

  let runStatus: "ok" | "error" = "ok";
  let runError: string | null = null;
  let problems: Problem[] = [];
  let outcome: AlertOutcome = "none";

  try {
    problems = await collectProblems(db, now);
    outcome = await reconcileAlert(db, problems, now, runLog);
  } catch (err) {
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    runLog.error("Chequeo de salud falló", { error: runError });
  }

  // `itemsFound` = problemas detectados; `itemsProcessed` = 1 si se avisó algo.
  const alerted = outcome === "alert-sent" || outcome === "recovery-sent";
  await finishRun(runId, {
    status: runStatus,
    itemsFound: problems.length,
    itemsProcessed: alerted ? 1 : 0,
    error: runError,
  });
  runLog.info("Chequeo de salud terminado", {
    status: runStatus,
    problems: problems.length,
    outcome,
  });

  return json(
    {
      ok: runStatus === "ok",
      runId,
      healthy: problems.length === 0,
      problems: problems.map((p) => p.key),
      outcome,
    },
    runStatus === "ok" ? 200 : 500,
  );
}

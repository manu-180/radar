/**
 * Ruta de clasificación de leads.
 *
 * `POST /api/process` drena la cola de clasificación: reclama un lote de leads
 * `pending`, los clasifica con Claude y persiste el resultado. Es el corazón
 * del paso de IA del sistema.
 *
 * Diseño:
 *  - **Reclamo sin condiciones de carrera**: el lote se toma con la función
 *    `claim_pending_leads`, que usa `FOR UPDATE SKIP LOCKED`. Dos corridas
 *    solapadas nunca clasifican el mismo lead.
 *  - **Concurrencia acotada**: el lote se procesa en sub-lotes para no abrir
 *    demasiadas llamadas a Claude a la vez.
 *  - **Escalado de los `maybe`**: lo ambiguo se reintenta con un modelo más
 *    capaz antes de darlo por clasificado.
 *  - **Errores transitorios vs. reales**: un 429/5xx de Anthropic devuelve el
 *    lead a `pending` sin quemarle un intento; un error de contenido/parseo sí
 *    cuenta como intento y, tras varios, marca el lead `failed`.
 *  - **Drenado del backlog**: si quedan leads `pending`, la ruta se vuelve a
 *    disparar a sí misma (con un tope de profundidad) para vaciar la cola sin
 *    esperar al próximo tick del cron.
 *
 * La dispara el cron; está protegida por el header `x-cron-secret`.
 */

import { after } from "next/server";

import Anthropic from "@anthropic-ai/sdk";

import {
  classifyLead,
  DEFAULT_CLASSIFIER_MODEL,
  ESCALATION_MODEL,
  type ClassificationUsage,
  type ClassifyLeadInput,
  type FeedbackExample,
  type LeadCategory,
} from "@/lib/ai/classifier";
import { finishRun, startRun } from "@/lib/db/runs";
import { env } from "@/lib/env";
import { createLogger, type Logger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/security";
import { getAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/types/database";

/** Cada corrida de clasificación se ejecuta sin caché. */
export const dynamic = "force-dynamic";
/** Clasificar un lote completo puede tardar: hasta 5 min por invocación. */
export const maxDuration = 300;

/** Tamaño del lote que se reclama de la cola en cada corrida. */
const BATCH_SIZE = 15;
/** Llamadas a Claude en vuelo a la vez dentro de un lote. */
const CONCURRENCY = 5;
/** Intentos antes de dar un lead por `failed`. */
const MAX_ATTEMPTS = 5;
/** Tope de re-disparos encadenados del drenado, para no entrar en bucle. */
const MAX_DRAIN_DEPTH = 8;

/**
 * Precios de los modelos, en USD por millón de tokens. Se usan para calcular
 * `llm_cost_usd` y poder seguir el gasto del clasificador.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  [DEFAULT_CLASSIFIER_MODEL]: { input: 1, output: 5 }, // Haiku 4.5
  [ESCALATION_MODEL]: { input: 3, output: 15 }, // Sonnet 4.6
};

/** Regla de notificación: qué categorías y qué score mínimo ameritan avisar. */
interface NotifyRule {
  categories: string[];
  minScore: number;
}

/** Valor por defecto de `notify_rule` si la clave falta en `settings`. */
const DEFAULT_NOTIFY_RULE: NotifyRule = { categories: ["hiring"], minScore: 70 };
/** Cantidad por defecto de ejemplos de feedback. */
const DEFAULT_FEEDBACK_COUNT = 6;

const log = createLogger({ route: "process" });

/** Atajo para responder JSON con un código de estado. */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** Redondea a 6 decimales, la precisión de la columna `llm_cost_usd`. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Costo en USD de una llamada, según el modelo y los tokens consumidos. */
function callCost(model: string, usage: ClassificationUsage): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (
    (usage.inputTokens / 1e6) * price.input +
    (usage.outputTokens / 1e6) * price.output
  );
}

/**
 * Decide si un error de Claude es **transitorio** (no es culpa del lead).
 *
 * Un error de conexión/red o una respuesta 429/5xx de la API son baches
 * temporales: el lead vuelve a `pending` sin gastar un intento. Cualquier otra
 * cosa (4xx de contenido, fallo de parseo, esquema inválido) es un error real
 * del lead y sí cuenta como intento.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === undefined || status === null) return true;
    return status === 429 || status >= 500;
  }
  return false;
}

/** Traduce el feedback humano de un lead a su categoría correcta. */
function feedbackToCategory(feedback: string): LeadCategory {
  // `responded` e `interested` confirman que el lead era una oportunidad real;
  // `not_relevant` la descarta. La categoría `maybe` no es un veredicto humano.
  return feedback === "not_relevant" ? "noise" : "hiring";
}

/** Lee `process.env`-style un entero del header `x-drain-depth` (default 0). */
function readDrainDepth(request: Request): number {
  const raw = request.headers.get("x-drain-depth");
  const depth = Number(raw);
  return Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

/** Configuración leída una vez de `settings` al arrancar la corrida. */
interface ProcessSettings {
  freelancerProfile: string;
  notifyRule: NotifyRule;
  feedbackCount: number;
}

/** Carga las claves de `settings` que necesita la clasificación. */
async function loadSettings(
  db: ReturnType<typeof getAdminClient>,
  runLog: Logger,
): Promise<ProcessSettings> {
  const { data, error } = await db
    .from("settings")
    .select("key, value")
    .in("key", ["freelancer_profile", "notify_rule", "feedback_examples_count"]);

  if (error) {
    throw new Error(`No se pudieron leer los settings: ${error.message}`);
  }

  const byKey = new Map<string, unknown>(
    (data ?? []).map((row) => [row.key as string, row.value]),
  );

  const profileRaw = byKey.get("freelancer_profile");
  const freelancerProfile = typeof profileRaw === "string" ? profileRaw : "";
  if (!freelancerProfile) {
    runLog.warn("settings.freelancer_profile ausente o vacío");
  }

  const ruleRaw = byKey.get("notify_rule");
  let notifyRule = DEFAULT_NOTIFY_RULE;
  if (
    ruleRaw &&
    typeof ruleRaw === "object" &&
    Array.isArray((ruleRaw as NotifyRule).categories) &&
    typeof (ruleRaw as NotifyRule).minScore === "number"
  ) {
    notifyRule = ruleRaw as NotifyRule;
  }

  const countRaw = byKey.get("feedback_examples_count");
  const feedbackCount =
    typeof countRaw === "number" && countRaw >= 0
      ? Math.floor(countRaw)
      : DEFAULT_FEEDBACK_COUNT;

  return { freelancerProfile, notifyRule, feedbackCount };
}

/**
 * Carga hasta `count` leads recientes con feedback humano, para calibrar el
 * criterio del clasificador (el loop de feedback del sistema).
 */
async function loadFeedbackExamples(
  db: ReturnType<typeof getAdminClient>,
  count: number,
): Promise<FeedbackExample[]> {
  if (count <= 0) return [];

  const { data, error } = await db
    .from("leads")
    .select("title, body, feedback")
    .not("feedback", "is", null)
    .order("feedback_at", { ascending: false, nullsFirst: false })
    .limit(count);

  if (error) {
    throw new Error(`No se pudieron leer los ejemplos de feedback: ${error.message}`);
  }

  return (data ?? []).map((row) => ({
    title: (row.title as string | null) ?? "",
    body: row.body as string | null,
    category: feedbackToCategory(row.feedback as string),
  }));
}

/** Resultado de clasificar un lead con escalado: agrega tokens y costo. */
interface ClassifyOutcome {
  score: number;
  category: LeadCategory;
  reason: string;
  suggested_reply: string;
  /** Modelo que produjo el resultado final (Haiku, o Sonnet si se escaló). */
  model: string;
  /** Tokens de entrada sumados sobre todas las llamadas hechas por el lead. */
  inputTokens: number;
  /** Tokens de salida sumados sobre todas las llamadas hechas por el lead. */
  outputTokens: number;
  /** Costo total en USD de todas las llamadas del lead. */
  costUsd: number;
}

/**
 * Clasifica un lead con Haiku y, si el resultado es `maybe`, reintenta con
 * Sonnet para desempatar. Los tokens y el costo se acumulan sobre ambas
 * llamadas; el resultado y el `model` reportados son los de la última.
 */
async function classifyWithEscalation(
  input: ClassifyLeadInput,
  freelancerProfile: string,
  feedbackExamples: FeedbackExample[],
): Promise<ClassifyOutcome> {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  const haiku = await classifyLead(input, {
    model: DEFAULT_CLASSIFIER_MODEL,
    freelancerProfile,
    feedbackExamples,
  });
  inputTokens += haiku.usage.inputTokens;
  outputTokens += haiku.usage.outputTokens;
  costUsd += callCost(DEFAULT_CLASSIFIER_MODEL, haiku.usage);

  let result = haiku.result;
  let model = DEFAULT_CLASSIFIER_MODEL;

  if (result.category === "maybe") {
    const sonnet = await classifyLead(input, {
      model: ESCALATION_MODEL,
      freelancerProfile,
      feedbackExamples,
    });
    inputTokens += sonnet.usage.inputTokens;
    outputTokens += sonnet.usage.outputTokens;
    costUsd += callCost(ESCALATION_MODEL, sonnet.usage);
    result = sonnet.result;
    model = ESCALATION_MODEL;
  }

  return {
    score: result.score,
    category: result.category,
    reason: result.reason,
    suggested_reply: result.suggested_reply,
    model,
    inputTokens,
    outputTokens,
    costUsd: round6(costUsd),
  };
}

/** Desenlace de procesar un lead, para las métricas de la corrida. */
type LeadStatus = "done" | "retry-transient" | "retry-real" | "failed";

/**
 * Procesa un lead reclamado: lo clasifica y persiste el resultado.
 *
 * Nunca lanza: cualquier error se traduce a una actualización del lead (vuelta
 * a `pending` o `failed`) y a un {@link LeadStatus}, para no abortar el lote.
 */
async function processLead(
  lead: Tables<"leads">,
  settings: ProcessSettings,
  feedbackExamples: FeedbackExample[],
  db: ReturnType<typeof getAdminClient>,
  runLog: Logger,
): Promise<LeadStatus> {
  const leadLog = runLog.child({ leadId: lead.id });

  const input: ClassifyLeadInput = {
    title: lead.title ?? "",
    body: lead.body ?? "",
    url: lead.url ?? "",
    lang: lead.lang ?? "other",
    source: lead.source,
    prefilter_matched: lead.prefilter_matched ?? [],
  };

  /** Aplica un patch al lead; un fallo de DB se loguea pero no se propaga. */
  const patch = async (
    fields: Partial<Tables<"leads">>,
    onFail: string,
  ): Promise<void> => {
    const { error } = await db.from("leads").update(fields).eq("id", lead.id);
    if (error) leadLog.error(onFail, { error: error.message });
  };

  try {
    const outcome = await classifyWithEscalation(
      input,
      settings.freelancerProfile,
      feedbackExamples,
    );

    // ¿El lead amerita una notificación según la regla configurada?
    const qualifies =
      settings.notifyRule.categories.includes(outcome.category) &&
      outcome.score >= settings.notifyRule.minScore;

    await patch(
      {
        score: outcome.score,
        category: outcome.category,
        reason: outcome.reason,
        suggested_reply: outcome.suggested_reply,
        llm_model: outcome.model,
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        llm_cost_usd: outcome.costUsd,
        llm_status: "done",
        llm_error: null,
        // Si no califica, se cierra la cola de notificación; si califica, se
        // deja `pending` para que el paso de notificación lo tome.
        ...(qualifies ? {} : { notify_status: "skipped" }),
      },
      "No se pudo persistir la clasificación del lead",
    );

    leadLog.info("Lead clasificado", {
      category: outcome.category,
      score: outcome.score,
      model: outcome.model,
      costUsd: outcome.costUsd,
      notify: qualifies ? "pending" : "skipped",
    });
    return "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Error transitorio: el lead vuelve a `pending` SIN gastar un intento.
    if (isTransientError(err)) {
      await patch(
        { llm_status: "pending" },
        "No se pudo devolver el lead a pending tras un error transitorio",
      );
      leadLog.warn("Error transitorio al clasificar; lead devuelto a pending", {
        error: message,
      });
      return "retry-transient";
    }

    // Error real (contenido/parseo): consume un intento.
    const attempts = lead.llm_attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    await patch(
      {
        llm_status: exhausted ? "failed" : "pending",
        llm_attempts: attempts,
        llm_error: message,
      },
      "No se pudo registrar el error de clasificación del lead",
    );
    if (exhausted) {
      leadLog.error("Lead marcado como failed tras agotar los intentos", {
        attempts,
        error: message,
      });
      return "failed";
    }
    leadLog.warn("Error real al clasificar; lead devuelto a pending", {
      attempts,
      error: message,
    });
    return "retry-real";
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!verifyCronSecret(request)) {
    return json({ error: "No autorizado" }, 401);
  }

  const drainDepth = readDrainDepth(request);
  const db = getAdminClient();

  const runId = await startRun("process");
  const runLog = log.child({ runId, drainDepth });
  runLog.info("Corrida de clasificación iniciada");

  let runStatus: "ok" | "error" = "ok";
  let runError: string | null = null;
  const tally: Record<LeadStatus, number> = {
    done: 0,
    "retry-transient": 0,
    "retry-real": 0,
    failed: 0,
  };
  let claimed = 0;

  try {
    // Los settings y el feedback se cargan ANTES de reclamar: si fallan, no
    // dejamos leads colgados en `processing`.
    const settings = await loadSettings(db, runLog);
    const feedbackExamples = await loadFeedbackExamples(db, settings.feedbackCount);

    // Reclamo atómico del lote (FOR UPDATE SKIP LOCKED dentro de la función).
    const { data: leads, error: claimErr } = await db.rpc("claim_pending_leads", {
      batch_size: BATCH_SIZE,
    });
    if (claimErr) {
      throw new Error(`No se pudo reclamar el lote: ${claimErr.message}`);
    }

    const batch = (leads ?? []) as Tables<"leads">[];
    claimed = batch.length;
    runLog.info("Lote reclamado", {
      claimed,
      feedbackExamples: feedbackExamples.length,
    });

    // Clasificación con concurrencia acotada: sub-lotes en paralelo.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);
      const statuses = await Promise.all(
        chunk.map((lead) =>
          processLead(lead, settings, feedbackExamples, db, runLog),
        ),
      );
      for (const status of statuses) tally[status] += 1;
    }
  } catch (err) {
    runStatus = "error";
    runError = err instanceof Error ? err.message : String(err);
    runLog.error("Corrida de clasificación falló", { error: runError });
  }

  // `itemsProcessed` cuenta los leads que quedaron clasificados en esta corrida.
  await finishRun(runId, {
    status: runStatus,
    itemsProcessed: tally.done,
    error: runError,
  });
  runLog.info("Corrida de clasificación terminada", {
    status: runStatus,
    claimed,
    ...tally,
  });

  // Drenado del backlog: si quedan leads `pending` y no se llegó al tope de
  // profundidad, re-disparar la ruta para vaciar la cola sin esperar al cron.
  const { count, error: countErr } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("llm_status", "pending");
  const pending = count ?? 0;
  if (countErr) {
    runLog.warn("No se pudo contar los leads pendientes", { error: countErr.message });
  }

  if (pending > 0 && drainDepth < MAX_DRAIN_DEPTH) {
    runLog.info("Quedan leads pendientes; se reencola el drenado", {
      pending,
      nextDepth: drainDepth + 1,
    });
    after(async () => {
      try {
        const response = await fetch(`${env.APP_URL}/api/process`, {
          method: "POST",
          headers: {
            "x-cron-secret": env.CRON_SECRET,
            "x-drain-depth": String(drainDepth + 1),
          },
        });
        if (!response.ok) {
          throw new Error(`/api/process respondió ${response.status}`);
        }
      } catch (err) {
        runLog.error("No se pudo reencolar el drenado", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } else if (pending > 0) {
    runLog.warn("Quedan leads pendientes pero se alcanzó el tope de drenado", {
      pending,
      drainDepth,
    });
  }

  return json(
    {
      ok: runStatus === "ok",
      runId,
      claimed,
      classified: tally.done,
      retriedTransient: tally["retry-transient"],
      retriedReal: tally["retry-real"],
      failed: tally.failed,
      pending,
    },
    runStatus === "ok" ? 200 : 500,
  );
}

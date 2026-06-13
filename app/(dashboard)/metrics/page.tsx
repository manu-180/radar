/**
 * Página de métricas: embudo de leads y costo de IA.
 *
 * Server Component que consulta directamente `leads` y `runs` con el cliente
 * admin de Supabase. La métrica central es el **embudo** —de leads detectados
 * a leads respondidos— que revela en qué etapa se pierde valor: si el
 * pre-filtro descarta de más, si la IA califica poco o si los buenos leads no
 * se responden. El **costo de IA** sale de los tokens guardados por lead
 * (`llm_cost_usd`), así el gasto de Claude no vuela a ciegas.
 *
 * La página se renderiza siempre en el request (`force-dynamic`): los números
 * tienen que reflejar el estado actual de la base, no una versión cacheada.
 */

import type { Metadata } from "next";

import { getAdminClient } from "@/lib/supabase/admin";

import { PageHeader } from "../ui";

export const metadata: Metadata = { title: "Métricas" };

export const dynamic = "force-dynamic";

/** Milisegundos en un día, para calcular las ventanas temporales. */
const DAY_MS = 86_400_000;

/**
 * Etapas del embudo, en orden. Cada una aporta un `apply` que estrecha una
 * consulta de conteo sobre `leads`; la consulta base ya viene acotada a la
 * ventana temporal (`first_seen_at >= cutoff`).
 */
const FUNNEL_STAGES = [
  {
    key: "detected",
    label: "Detectados",
    apply: (q: LeadCountQuery) => q,
  },
  {
    key: "prefiltered",
    label: "Pasaron el pre-filtro",
    apply: (q: LeadCountQuery) => q.neq("llm_status", "skipped"),
  },
  {
    key: "classified",
    label: "Clasificados por IA",
    apply: (q: LeadCountQuery) => q.eq("llm_status", "done"),
  },
  {
    key: "hiring",
    label: "Categoría hiring",
    apply: (q: LeadCountQuery) => q.eq("category", "hiring"),
  },
  {
    key: "notified",
    label: "Notificados",
    apply: (q: LeadCountQuery) => q.eq("notify_status", "sent"),
  },
  {
    key: "responded",
    label: "Con feedback positivo",
    apply: (q: LeadCountQuery) => q.in("feedback", ["responded", "interested"]),
  },
] as const;

/** Índice de la etapa "clasificados" dentro de {@link FUNNEL_STAGES}. */
const CLASSIFIED_STAGE = 2;

/** Etiqueta legible de cada tipo de corrida. */
const KIND_LABELS: Record<string, string> = {
  poll: "Poll",
  process: "Proceso",
  notify: "Notificación",
  health: "Health-check",
};

/** Clases de color del badge de estado de una corrida. */
const STATUS_BADGE: Record<string, string> = {
  ok: "bg-green-100 text-green-800",
  error: "bg-red-100 text-red-800",
  running: "bg-amber-100 text-amber-800",
};

/** Etiqueta legible de cada estado de corrida. */
const STATUS_LABELS: Record<string, string> = {
  ok: "OK",
  error: "Error",
  running: "En curso",
};

/** Tipo del builder de conteo sobre `leads`, para tipar los `apply` del embudo. */
type LeadCountQuery = ReturnType<typeof leadCountBase>;

/** Cliente admin, compartido por todas las consultas de la página. */
const db = getAdminClient();

/** Crea una consulta de conteo exacto sobre `leads` (sin traer filas). */
function leadCountBase() {
  return db.from("leads").select("*", { count: "exact", head: true });
}

/** Fila de la tabla de corridas. */
interface RunRow {
  id: number;
  kind: string;
  source: string | null;
  status: string;
  items_found: number;
  items_new: number;
  items_processed: number;
  started_at: string;
  finished_at: string | null;
}

/** Formatea un monto en dólares: 4 decimales para costos chicos, 2 si llega a $1. */
function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** Formatea una fecha ISO a un formato corto en español. */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Duración de una corrida en segundos o minutos, o un texto si sigue abierta. */
function formatDuration(started: string, finished: string | null): string {
  if (!finished) return "en curso";
  const ms = new Date(finished).getTime() - new Date(started).getTime();
  if (ms < 0) return "—";
  const seconds = ms / 1000;
  return seconds < 90
    ? `${seconds.toFixed(1)} s`
    : `${(seconds / 60).toFixed(1)} min`;
}

/** Antigüedad de un timestamp en lenguaje natural ("hace 5 min"). */
function relativeTime(iso: string | null): string {
  if (!iso) return "sin registro";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

/**
 * Clasifica la frescura del último poll de una fuente comparándola con su
 * intervalo configurado: al día (`ok`), atrasado (`warn`) o sin señal (`stale`).
 */
function pollFreshness(
  iso: string | null,
  intervalMinutes: number,
): "ok" | "warn" | "stale" {
  if (!iso) return "stale";
  const ageMinutes = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (ageMinutes <= intervalMinutes * 2) return "ok";
  if (ageMinutes <= intervalMinutes * 6) return "warn";
  return "stale";
}

/** Barra horizontal simple: el ancho es la proporción `value / max`. */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
      <div
        className="h-2 rounded-full bg-[var(--accent)]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Tarjeta con una métrica destacada y, opcionalmente, una aclaración. */
function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-[var(--foreground)]">
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-xs text-[var(--subtle)]">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Embudo de una ventana temporal: una fila por etapa, con la barra escalada
 * contra los leads detectados y el porcentaje de conversión sobre ese tope.
 */
function FunnelView({ title, values }: { title: string; values: number[] }) {
  const detected = values[0] ?? 0;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="text-sm font-semibold text-[var(--foreground)]">{title}</h3>
      <ul className="mt-3 space-y-3">
        {FUNNEL_STAGES.map((stage, i) => {
          const value = values[i] ?? 0;
          const pct = detected > 0 ? Math.round((value / detected) * 100) : 0;
          return (
            <li key={stage.key} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-[var(--muted)]">{stage.label}</span>
                <span className="tabular-nums text-[var(--subtle)]">
                  <span className="font-medium text-[var(--foreground)]">
                    {value}
                  </span>{" "}
                  · {pct}%
                </span>
              </div>
              <Bar value={value} max={detected} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Resuelve las ventanas temporales del request: el "ahora" y los cortes de 7 y
 * 30 días. Vive en su propia función porque leer el reloj es impuro y no puede
 * hacerse directamente en el cuerpo de un componente.
 */
function resolveWindows() {
  const nowMs = Date.now();
  return {
    nowMs,
    cutoff7Ms: nowMs - 7 * DAY_MS,
    cutoff7: new Date(nowMs - 7 * DAY_MS).toISOString(),
    cutoff30: new Date(nowMs - 30 * DAY_MS).toISOString(),
  };
}

/** Cuenta los leads de cada etapa del embudo dentro de una ventana temporal. */
async function funnelFor(cutoffIso: string): Promise<number[]> {
  return Promise.all(
    FUNNEL_STAGES.map(async (stage) => {
      const { count } = await stage.apply(
        leadCountBase().gte("first_seen_at", cutoffIso),
      );
      return count ?? 0;
    }),
  );
}

export default async function MetricsPage() {
  const { cutoff7Ms, cutoff7, cutoff30 } = resolveWindows();

  // Fuentes primero: las consultas de "leads por fuente" y el indicador de
  // último poll necesitan la lista de slugs.
  const { data: sourcesData } = await db
    .from("sources")
    .select("slug, name, poll_interval_minutes")
    .order("name");
  const sources = (sourcesData ?? []) as {
    slug: string;
    name: string;
    poll_interval_minutes: number;
  }[];

  // El resto de las consultas son independientes entre sí: van en paralelo.
  const [funnel7, funnel30, runsRes, pollRes, costRes, perSource, hiringAll, classifiedAll] =
    await Promise.all([
      funnelFor(cutoff7),
      funnelFor(cutoff30),
      db
        .from("runs")
        .select(
          "id, kind, source, status, items_found, items_new, items_processed, started_at, finished_at",
        )
        .order("started_at", { ascending: false })
        .limit(20),
      db
        .from("runs")
        .select("source, started_at")
        .eq("kind", "poll")
        .eq("status", "ok")
        .order("started_at", { ascending: false })
        .limit(200),
      db
        .from("leads")
        .select("first_seen_at, llm_cost_usd")
        .eq("llm_status", "done")
        .gte("first_seen_at", cutoff30)
        .not("llm_cost_usd", "is", null)
        .limit(10_000),
      Promise.all(
        sources.map(async (s) => {
          const { count } = await leadCountBase().eq("source", s.slug);
          return { slug: s.slug, name: s.name, count: count ?? 0 };
        }),
      ),
      leadCountBase()
        .eq("category", "hiring")
        .then((r) => r.count ?? 0),
      leadCountBase()
        .eq("llm_status", "done")
        .then((r) => r.count ?? 0),
    ]);

  // --- Costo de IA: suma de tokens guardados por lead clasificado ---
  const costRows = (costRes.data ?? []) as {
    first_seen_at: string;
    llm_cost_usd: number;
  }[];
  const cost30 = costRows.reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0);
  const cost7 = costRows
    .filter((r) => new Date(r.first_seen_at).getTime() >= cutoff7Ms)
    .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0);
  const classified30 = funnel30[CLASSIFIED_STAGE] ?? 0;
  const avgCost = classified30 > 0 ? cost30 / classified30 : 0;

  // --- Tasa de calificación: hiring sobre el total de clasificados ---
  const qualRate = classifiedAll > 0 ? (hiringAll / classifiedAll) * 100 : 0;

  // --- Leads por fuente: tope para escalar las barras ---
  const maxSource = Math.max(1, ...perSource.map((s) => s.count));

  // --- Último poll exitoso por fuente ---
  const lastPoll = new Map<string, string>();
  for (const row of (pollRes.data ?? []) as {
    source: string | null;
    started_at: string;
  }[]) {
    if (row.source && !lastPoll.has(row.source)) {
      lastPoll.set(row.source, row.started_at);
    }
  }

  const runs = (runsRes.data ?? []) as RunRow[];
  const sourceName = new Map(sources.map((s) => [s.slug, s.name] as const));

  return (
    <section className="space-y-8">
      <PageHeader
        title="Métricas"
        subtitle="El embudo de los leads y el gasto de IA, a lo largo del tiempo."
      />

      {/* ===== Embudo de leads ===== */}
      <div className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Embudo de leads
          </h2>
          <p className="text-sm text-[var(--muted)]">
            Recorrido de los leads detectados en cada ventana, etapa por etapa.
            Una caída brusca marca dónde se pierde valor.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <FunnelView title="Últimos 7 días" values={funnel7} />
          <FunnelView title="Últimos 30 días" values={funnel30} />
        </div>
      </div>

      {/* ===== Costo de IA ===== */}
      <div className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--foreground)]">
            Costo de IA
          </h2>
          <p className="text-sm text-[var(--muted)]">
            Gasto de Claude calculado con los tokens guardados por cada lead
            clasificado.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Costo · 7 días" value={formatUsd(cost7)} />
          <StatCard label="Costo · 30 días" value={formatUsd(cost30)} />
          <StatCard
            label="Costo prom. / lead"
            value={formatUsd(avgCost)}
            hint={`${classified30} clasificados en 30 días`}
          />
        </div>
      </div>

      {/* ===== Calidad y volumen ===== */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-[var(--foreground)]">
          Calidad y volumen
        </h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <StatCard
            label="Tasa de calificación"
            value={`${qualRate.toFixed(1)}%`}
            hint={`${hiringAll} hiring de ${classifiedAll} clasificados`}
          />
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 lg:col-span-2">
            <h3 className="text-sm font-semibold text-[var(--foreground)]">
              Leads por fuente
            </h3>
            {perSource.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">
                No hay fuentes configuradas.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {perSource.map((s) => (
                  <li key={s.slug} className="space-y-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-[var(--muted)]">{s.name}</span>
                      <span className="tabular-nums font-medium text-[var(--foreground)]">
                        {s.count}
                      </span>
                    </div>
                    <Bar value={s.count} max={maxSource} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ===== Últimas corridas ===== */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-[var(--foreground)]">
          Últimas corridas
        </h2>
        {runs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-6 text-center text-sm text-[var(--muted)]">
            Todavía no se registró ninguna corrida.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] scroll-elegant">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-4 py-3 font-medium">Tipo</th>
                  <th className="px-4 py-3 font-medium">Fuente</th>
                  <th className="px-4 py-3 font-medium">Estado</th>
                  <th className="px-4 py-3 font-medium">Items</th>
                  <th className="px-4 py-3 font-medium">Duración</th>
                  <th className="px-4 py-3 font-medium">Inicio</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--foreground)]">
                      {KIND_LABELS[run.kind] ?? run.kind}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {run.source
                        ? (sourceName.get(run.source) ?? run.source)
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          STATUS_BADGE[run.status] ?? "bg-zinc-100 text-zinc-600"
                        }`}
                      >
                        {STATUS_LABELS[run.status] ?? run.status}
                      </span>
                    </td>
                    <td
                      className="px-4 py-3 whitespace-nowrap tabular-nums text-[var(--muted)]"
                      title="encontrados / nuevos / procesados"
                    >
                      {run.items_found} / {run.items_new} /{" "}
                      {run.items_processed}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap tabular-nums text-[var(--muted)]">
                      {formatDuration(run.started_at, run.finished_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {formatDateTime(run.started_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ===== Último poll exitoso por fuente ===== */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold text-[var(--foreground)]">
          Último poll exitoso
        </h2>
        {sources.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-6 text-center text-sm text-[var(--muted)]">
            No hay fuentes configuradas.
          </p>
        ) : (
          <ul className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:grid-cols-2">
            {sources.map((s) => {
              const ts = lastPoll.get(s.slug) ?? null;
              const freshness = pollFreshness(ts, s.poll_interval_minutes);
              const dotColor =
                freshness === "ok"
                  ? "bg-[var(--ok-solid)]"
                  : freshness === "warn"
                    ? "bg-[var(--warn-solid)]"
                    : "bg-[var(--danger-solid)]";
              return (
                <li
                  key={s.slug}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${dotColor}`}
                      aria-hidden
                    />
                    <span className="text-[var(--foreground)]">{s.name}</span>
                  </span>
                  <span className="text-right text-[var(--muted)]">
                    {relativeTime(ts)}
                    {ts ? (
                      <span className="ml-2 text-xs text-[var(--subtle)]">
                        {formatDateTime(ts)}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

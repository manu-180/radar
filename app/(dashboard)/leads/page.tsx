/**
 * Pantalla principal del dashboard: la lista de leads para triagear.
 *
 * Server Component que lee la tabla `leads` con el cliente admin de Supabase.
 * Todo el filtrado, ordenado y paginado viaja por query params, así que la URL
 * es compartible y la página queda en renderizado dinámico (depende de
 * `searchParams`). El detalle de cada lead vive en `/leads/[id]` (paso 21).
 */

import type { Metadata } from "next";
import Link from "next/link";

import { getAdminClient } from "@/lib/supabase/admin";

import { CATEGORY_BADGE, FEEDBACK_LABELS, NOTIFY_LABELS } from "../labels";
import { Card, EmptyState, ErrorNote, PageHeader } from "../ui";

export const metadata: Metadata = { title: "Leads" };

/** Render dinámico: depende de `searchParams` y del estado vivo de la base. */
export const dynamic = "force-dynamic";

/** Cantidad de leads por página. */
const PAGE_SIZE = 50;

/**
 * Opciones del filtro de categoría. `relevant` es el valor por defecto: junta
 * `hiring` + `maybe`, que es lo que conviene triagear primero.
 */
const CATEGORY_FILTERS = {
  relevant: "Relevantes (hiring + maybe)",
  hiring: "Hiring",
  maybe: "Maybe",
  noise: "Noise",
  all: "Todas",
} as const;

/**
 * Opciones del filtro de feedback. `none` es el valor por defecto: leads sin
 * feedback todavía, es decir los que falta revisar.
 */
const FEEDBACK_FILTERS = {
  none: "Sin feedback",
  responded: "Respondido",
  interested: "Interesado",
  not_relevant: "No relevante",
  all: "Todos",
} as const;

/** Opciones del filtro por estado de clasificación con IA. `""` = todos. */
const LLM_STATUSES = {
  "": "Todos los estados",
  pending: "Pendiente",
  processing: "Procesando",
  done: "Clasificado",
  failed: "Falló",
  skipped: "Descartado",
} as const;

/** Forma de la fila de lead que trae el listado. */
interface LeadListRow {
  id: number;
  source: string;
  title: string | null;
  score: number | null;
  category: "hiring" | "maybe" | "noise" | null;
  posted_at: string | null;
  notify_status: string;
  feedback: string | null;
  first_seen_at: string;
}

/** Devuelve el primer valor de un search param que puede venir repetido. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Devuelve `value` si es una clave válida de `options`; si no, `fallback`.
 * Blinda el parseo de los query params contra valores arbitrarios en la URL.
 */
function pick<T extends string>(
  value: string | undefined,
  options: Record<T, unknown>,
  fallback: T,
): T {
  return value !== undefined && value in options ? (value as T) : fallback;
}

/** Escapa los comodines de `LIKE` para que el buscador trate el texto literal. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Arma el `href` del listado conservando los filtros activos y la página. */
function buildHref(params: Record<string, string>, page: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  if (page > 1) search.set("page", String(page));
  const qs = search.toString();
  return qs ? `/leads?${qs}` : "/leads";
}

/** Formatea una fecha ISO a un formato corto en español, o `—` si es nula. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Recorta el título para que no desborde la columna. */
function shortTitle(title: string | null): string {
  if (!title) return "(sin título)";
  return title.length > 90 ? `${title.slice(0, 90)}…` : title;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;

  // --- Filtros (validados contra sus conjuntos de valores permitidos) ---
  const source = first(sp.source)?.trim() ?? "";
  const category = pick(first(sp.category), CATEGORY_FILTERS, "relevant");
  const llmStatus = pick(first(sp.llm_status), LLM_STATUSES, "");
  const feedback = pick(first(sp.feedback), FEEDBACK_FILTERS, "none");
  const q = first(sp.q)?.trim() ?? "";
  const page = Math.max(1, Number.parseInt(first(sp.page) ?? "1", 10) || 1);

  // Filtros activos, para reconstruir hrefs de paginación.
  const activeFilters: Record<string, string> = {
    source,
    category,
    llm_status: llmStatus,
    feedback,
    q,
  };

  const db = getAdminClient();

  // Lista de fuentes para el desplegable: nombres legibles ordenados.
  const { data: sources } = await db
    .from("sources")
    .select("slug, name")
    .order("name");

  // --- Consulta de leads con filtros, orden y paginado ---
  let query = db
    .from("leads")
    .select(
      "id, source, title, score, category, posted_at, notify_status, feedback, first_seen_at",
      { count: "exact" },
    )
    .order("first_seen_at", { ascending: false });

  if (source) query = query.eq("source", source);

  if (category === "relevant") {
    query = query.in("category", ["hiring", "maybe"]);
  } else if (category !== "all") {
    query = query.eq("category", category);
  }

  if (llmStatus) query = query.eq("llm_status", llmStatus);

  if (feedback === "none") {
    query = query.is("feedback", null);
  } else if (feedback !== "all") {
    query = query.eq("feedback", feedback);
  }

  if (q) query = query.ilike("title", `%${escapeLike(q)}%`);

  const from = (page - 1) * PAGE_SIZE;
  query = query.range(from, from + PAGE_SIZE - 1);

  const { data, count, error } = await query;

  const sourceName = new Map(
    (sources ?? []).map((s) => [s.slug, s.name] as const),
  );
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = (data ?? []) as LeadListRow[];

  const fieldClass =
    "rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] focus-ring";

  return (
    <section className="space-y-6">
      <PageHeader
        title="Leads"
        subtitle="Los candidatos detectados en las plataformas, clasificados por la IA."
        actions={
          <span className="text-sm text-[var(--muted)]">
            {total} {total === 1 ? "lead" : "leads"}
          </span>
        }
      />

      {/* Filtros: form GET, así cada filtro queda en la URL. Sin campo `page`,
          de modo que filtrar vuelve siempre a la primera página. */}
      <form
        method="get"
        action="/leads"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Fuente
          <select name="source" defaultValue={source} className={fieldClass}>
            <option value="">Todas las fuentes</option>
            {(sources ?? []).map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Categoría
          <select
            name="category"
            defaultValue={category}
            className={fieldClass}
          >
            {Object.entries(CATEGORY_FILTERS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Estado IA
          <select
            name="llm_status"
            defaultValue={llmStatus}
            className={fieldClass}
          >
            {Object.entries(LLM_STATUSES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Feedback
          <select
            name="feedback"
            defaultValue={feedback}
            className={fieldClass}
          >
            {Object.entries(FEEDBACK_FILTERS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Buscar en el título
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Texto del título…"
            className={`${fieldClass} min-w-56`}
          />
        </label>

        <button
          type="submit"
          className="inline-flex items-center rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] focus-ring"
        >
          Filtrar
        </button>
        <Link
          href="/leads"
          className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] focus-ring"
        >
          Limpiar
        </Link>
      </form>

      {error ? (
        <ErrorNote>No se pudieron cargar los leads: {error.message}</ErrorNote>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No hay leads que coincidan"
          description="Probá aflojar los filtros, o esperá a que el próximo poll traiga candidatos nuevos."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto scroll-elegant">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="px-4 py-3 font-medium">Fuente</th>
                  <th className="px-4 py-3 font-medium">Título</th>
                  <th className="px-4 py-3 text-right font-medium">Score</th>
                  <th className="px-4 py-3 font-medium">Categoría</th>
                  <th className="px-4 py-3 font-medium">Fecha del post</th>
                  <th className="px-4 py-3 font-medium">Notificación</th>
                  <th className="px-4 py-3 font-medium">Feedback</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((lead) => (
                  <tr
                    key={lead.id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]"
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {sourceName.get(lead.source) ?? lead.source}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="font-medium text-[var(--foreground)] hover:text-[var(--accent)] hover:underline"
                      >
                        {shortTitle(lead.title)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--muted)]">
                      {lead.score ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {lead.category ? (
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_BADGE[lead.category]}`}
                        >
                          {lead.category}
                        </span>
                      ) : (
                        <span className="text-[var(--subtle)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {formatDate(lead.posted_at)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {NOTIFY_LABELS[lead.notify_status] ?? lead.notify_status}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {lead.feedback
                        ? (FEEDBACK_LABELS[lead.feedback] ?? lead.feedback)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Paginación: conserva los filtros activos en cada enlace. */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-[var(--muted)]">
            Página {page} de {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={buildHref(activeFilters, page - 1)}
                className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)] focus-ring"
              >
                Anterior
              </Link>
            ) : (
              <span className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--subtle)]">
                Anterior
              </span>
            )}
            {page < totalPages ? (
              <Link
                href={buildHref(activeFilters, page + 1)}
                className="rounded-lg border border-[var(--border-strong)] px-3 py-1.5 font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)] focus-ring"
              >
                Siguiente
              </Link>
            ) : (
              <span className="rounded-lg border border-[var(--border)] px-3 py-1.5 font-medium text-[var(--subtle)]">
                Siguiente
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

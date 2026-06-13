/**
 * Detalle de un lead: `/leads/[id]`.
 *
 * Esta ruta es exactamente la que enlazan las notificaciones de WhatsApp
 * (paso 17), así que el segmento dinámico no puede cambiar de nombre.
 *
 * Server Component que lee la fila completa de `leads` con el cliente admin.
 * Muestra el contexto del post, la clasificación de la IA y el mensaje
 * sugerido. Lo interactivo —copiar el mensaje, marcar feedback— vive en
 * Client Components mínimos (`CopyButton`, `FeedbackButtons`).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getAdminClient } from "@/lib/supabase/admin";

import { CATEGORY_BADGE, LLM_STATUS_LABELS, NOTIFY_LABELS } from "../../labels";

import type { FeedbackValue } from "./actions";
import { CopyButton } from "./copy-button";
import { FeedbackButtons } from "./feedback-buttons";

export const metadata: Metadata = { title: "Detalle de lead" };

/** Formatea una fecha ISO a fecha + hora en español, o `—` si es nula. */
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Formatea el costo de la clasificación en dólares, o `—` si no lo hay. */
function formatCost(cost: number | null): string {
  if (cost === null) return "—";
  return `US$ ${Number(cost).toFixed(6)}`;
}

/** Una fila etiqueta/valor dentro de una tarjeta de datos. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-[var(--subtle)]">
        {label}
      </dt>
      <dd className="text-sm text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // El id de la URL es texto libre: lo aceptamos solo si es un entero positivo.
  const leadId = Number(id);
  if (!Number.isInteger(leadId) || leadId <= 0) notFound();

  const db = getAdminClient();
  const { data: lead, error } = await db
    .from("leads")
    .select(
      "id, source, external_id, title, body, url, author, lang, posted_at, prefilter_matched, llm_status, llm_model, llm_error, input_tokens, output_tokens, llm_cost_usd, score, category, reason, suggested_reply, notify_status, notified_at, feedback, feedback_at, first_seen_at",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (error) {
    return (
      <section className="space-y-4">
        <Link
          href="/leads"
          className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] hover:underline"
        >
          ← Volver a leads
        </Link>
        <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger-soft-fg)]">
          No se pudo cargar el lead: {error.message}
        </p>
      </section>
    );
  }

  if (!lead) notFound();

  // Nombre legible de la fuente (cae al slug si la fuente no está registrada).
  const { data: source } = await db
    .from("sources")
    .select("name")
    .eq("slug", lead.source)
    .maybeSingle();
  const sourceName = source?.name ?? lead.source;

  const prefilterTerms: string[] = lead.prefilter_matched ?? [];
  const suggestedReply = lead.suggested_reply?.trim() ?? "";

  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)] focus-ring"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
            <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Volver a leads
        </Link>
        <h1 className="text-xl font-semibold tracking-tight text-[var(--foreground)]">
          {lead.title?.trim() || "(sin título)"}
        </h1>
      </div>

      {/* --- Contexto del post --- */}
      <article className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Contexto</h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Fuente">{sourceName}</Field>
          <Field label="Autor">{lead.author?.trim() || "—"}</Field>
          <Field label="Idioma">{lead.lang || "—"}</Field>
          <Field label="Fecha del post">
            {formatDateTime(lead.posted_at)}
          </Field>
          <Field label="Visto por primera vez">
            {formatDateTime(lead.first_seen_at)}
          </Field>
          <Field label="Notificación">
            {NOTIFY_LABELS[lead.notify_status] ?? lead.notify_status}
            {lead.notified_at ? ` · ${formatDateTime(lead.notified_at)}` : ""}
          </Field>
        </dl>

        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--subtle)]">
            Cuerpo del post
          </h3>
          {lead.body?.trim() ? (
            <p className="whitespace-pre-wrap text-sm text-[var(--foreground)]">
              {lead.body}
            </p>
          ) : (
            <p className="text-sm text-[var(--subtle)]">(sin cuerpo)</p>
          )}
        </div>

        {lead.url && (
          <a
            href={lead.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent)] hover:underline focus-ring"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Ver post original
          </a>
        )}
      </article>

      {/* --- Clasificación de la IA --- */}
      <article className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">
          Clasificación de la IA
        </h2>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="Estado">
            {LLM_STATUS_LABELS[lead.llm_status] ?? lead.llm_status}
          </Field>
          <Field label="Score">
            <span className="tabular-nums">
              {lead.score === null ? "—" : `${lead.score}/100`}
            </span>
          </Field>
          <Field label="Categoría">
            {lead.category ? (
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_BADGE[lead.category]}`}
              >
                {lead.category}
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Costo">{formatCost(lead.llm_cost_usd)}</Field>
          <Field label="Modelo">{lead.llm_model || "—"}</Field>
          <Field label="Tokens">
            <span className="tabular-nums">
              {lead.input_tokens === null && lead.output_tokens === null
                ? "—"
                : `${lead.input_tokens ?? 0} in · ${lead.output_tokens ?? 0} out`}
            </span>
          </Field>
        </dl>

        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--subtle)]">
            Razón
          </h3>
          <p className="text-sm text-[var(--foreground)]">
            {lead.reason?.trim() || (
              <span className="text-[var(--subtle)]">
                Todavía sin clasificar por la IA.
              </span>
            )}
          </p>
        </div>

        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--subtle)]">
            Términos del pre-filtro
          </h3>
          {prefilterTerms.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {prefilterTerms.map((term) => (
                <li
                  key={term}
                  className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--muted)]"
                >
                  {term}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--subtle)]">
              Ninguno (el lead no pasó por el pre-filtro de keywords).
            </p>
          )}
        </div>

        {lead.llm_error && (
          <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-2 text-sm text-[var(--danger-soft-fg)]">
            Error de clasificación: {lead.llm_error}
          </p>
        )}
      </article>

      {/* --- Mensaje sugerido --- */}
      <article className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">
            Mensaje sugerido
          </h2>
          {suggestedReply && <CopyButton text={suggestedReply} />}
        </div>
        {suggestedReply ? (
          <p className="whitespace-pre-wrap rounded-lg bg-[var(--surface-2)] p-3 text-sm text-[var(--foreground)]">
            {suggestedReply}
          </p>
        ) : (
          <p className="text-sm text-[var(--subtle)]">
            La IA no propuso un mensaje para este lead.
          </p>
        )}
      </article>

      {/* --- Feedback --- */}
      <article className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Feedback</h2>
          <p className="text-xs text-[var(--muted)]">
            Lo usa el clasificador como ejemplo para calibrarse.
            {lead.feedback_at
              ? ` Última marca: ${formatDateTime(lead.feedback_at)}.`
              : ""}
          </p>
        </div>
        <FeedbackButtons
          leadId={lead.id}
          current={(lead.feedback as FeedbackValue | null) ?? null}
        />
      </article>
    </section>
  );
}

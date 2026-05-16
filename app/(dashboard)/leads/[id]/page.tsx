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

import Link from "next/link";
import { notFound } from "next/navigation";

import { getAdminClient } from "@/lib/supabase/admin";

import type { FeedbackValue } from "./actions";
import { CopyButton } from "./copy-button";
import { FeedbackButtons } from "./feedback-buttons";

/** Clases de color del badge de categoría. */
const CATEGORY_BADGE: Record<string, string> = {
  hiring: "bg-green-100 text-green-800",
  maybe: "bg-amber-100 text-amber-800",
  noise: "bg-zinc-100 text-zinc-600",
};

/** Etiqueta legible de cada estado de clasificación con IA. */
const LLM_STATUS_LABELS: Record<string, string> = {
  pending: "Pendiente",
  processing: "Procesando",
  done: "Clasificado",
  failed: "Falló",
  skipped: "Descartado",
};

/** Etiqueta legible de cada estado de notificación. */
const NOTIFY_LABELS: Record<string, string> = {
  pending: "Pendiente",
  sending: "Enviando",
  sent: "Enviada",
  failed: "Falló",
  skipped: "Descartada",
};

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
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </dt>
      <dd className="text-sm text-zinc-800">{children}</dd>
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
        <Link href="/leads" className="text-sm text-zinc-600 hover:underline">
          ← Volver a leads
        </Link>
        <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
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
        <Link href="/leads" className="text-sm text-zinc-600 hover:underline">
          ← Volver a leads
        </Link>
        <h1 className="text-xl font-semibold text-zinc-900">
          {lead.title?.trim() || "(sin título)"}
        </h1>
      </div>

      {/* --- Contexto del post --- */}
      <article className="space-y-4 rounded-lg border border-zinc-200 p-4">
        <h2 className="text-sm font-semibold text-zinc-900">Contexto</h2>
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
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Cuerpo del post
          </h3>
          {lead.body?.trim() ? (
            <p className="whitespace-pre-wrap text-sm text-zinc-800">
              {lead.body}
            </p>
          ) : (
            <p className="text-sm text-zinc-400">(sin cuerpo)</p>
          )}
        </div>

        {lead.url && (
          <a
            href={lead.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm font-medium text-blue-700 hover:underline"
          >
            🔗 Ver post original
          </a>
        )}
      </article>

      {/* --- Clasificación de la IA --- */}
      <article className="space-y-4 rounded-lg border border-zinc-200 p-4">
        <h2 className="text-sm font-semibold text-zinc-900">
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
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Razón
          </h3>
          <p className="text-sm text-zinc-800">
            {lead.reason?.trim() || (
              <span className="text-zinc-400">
                Todavía sin clasificar por la IA.
              </span>
            )}
          </p>
        </div>

        <div className="space-y-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Términos del pre-filtro
          </h3>
          {prefilterTerms.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {prefilterTerms.map((term) => (
                <li
                  key={term}
                  className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700"
                >
                  {term}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-400">
              Ninguno (el lead no pasó por el pre-filtro de keywords).
            </p>
          )}
        </div>

        {lead.llm_error && (
          <p className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            Error de clasificación: {lead.llm_error}
          </p>
        )}
      </article>

      {/* --- Mensaje sugerido --- */}
      <article className="space-y-3 rounded-lg border border-zinc-200 p-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-zinc-900">
            Mensaje sugerido
          </h2>
          {suggestedReply && <CopyButton text={suggestedReply} />}
        </div>
        {suggestedReply ? (
          <p className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-sm text-zinc-800">
            {suggestedReply}
          </p>
        ) : (
          <p className="text-sm text-zinc-400">
            La IA no propuso un mensaje para este lead.
          </p>
        )}
      </article>

      {/* --- Feedback --- */}
      <article className="space-y-3 rounded-lg border border-zinc-200 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-zinc-900">Feedback</h2>
          <p className="text-xs text-zinc-500">
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

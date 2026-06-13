/**
 * Lista de conversaciones: `/conversations`.
 *
 * Server Component que lee `conversations` (con el título del lead vía join) con
 * el cliente admin de Supabase. Los filtros (estado, canal) viajan por query
 * params, así la URL es compartible y la página queda en render dinámico. Cada
 * fila muestra canal, contacto, etapa, medidor de interés, último mensaje,
 * estado y un toggle de autopilot, y enlaza al thread.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { getAdminClient } from "@/lib/supabase/admin";
import type { Conversation, ConversationStatus } from "@/types/autopilot";

import {
  Badge,
  Card,
  ChannelBadge,
  EmptyState,
  ErrorNote,
  InterestMeter,
  isHandoff,
  PageHeader,
  relativeFuture,
  relativeTime,
  StageBadge,
  STATUS_META,
  StatusBadge,
} from "../ui";
import { AutopilotToggle } from "./autopilot-toggle";

export const metadata: Metadata = { title: "Conversaciones" };

/** Render dinámico: depende de `searchParams` y del estado vivo de la base. */
export const dynamic = "force-dynamic";

/** Cuántas conversaciones traer (la lista es de un solo usuario, alcanza). */
const LIMIT = 100;

/** Filtros de estado: grupos útiles + cada estado conocido. `""` = todas. */
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Todos los estados" },
  { value: "open", label: "Abiertas (activas + esperando)" },
  { value: "handoff", label: "Handoffs pendientes" },
  { value: "awaiting_owner", label: "Te toca responder" },
  { value: "active", label: "Activas" },
  { value: "awaiting_reply", label: "Esperando respuesta" },
  { value: "won", label: "Ganadas" },
  { value: "lost", label: "Perdidas" },
  { value: "paused", label: "Pausadas" },
];

/** Estados que cuentan como "abiertas" para el filtro agrupado. */
const OPEN_STATUSES: ConversationStatus[] = [
  "active",
  "awaiting_reply",
  "awaiting_owner",
  "wants_draft",
  "handed_off",
];

const HANDOFF_STATUSES: ConversationStatus[] = ["wants_draft", "handed_off"];

const CHANNEL_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Todos los canales" },
  { value: "telegram", label: "Telegram" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "bluesky", label: "Bluesky" },
  { value: "reddit", label: "Reddit" },
];

/** Forma de la fila: la conversación + el título del lead (join). */
type Row = Conversation & {
  leads: { title: string | null } | { title: string | null }[] | null;
  last_message?: { body: string; direction: string }[] | null;
};

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Normaliza el título que puede venir como objeto o array desde el join. */
function leadTitle(row: Row): string {
  const l = row.leads;
  const t = Array.isArray(l) ? l[0]?.title : l?.title;
  return t?.trim() || "(lead sin título)";
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const statusFilter = first(sp.status) ?? "";
  const channelFilter = first(sp.channel) ?? "";

  const db = getAdminClient();

  let query = db
    .from("conversations")
    .select(
      "id, lead_id, channel, contact_handle, status, stage, interest_level, autopilot, message_count, outbound_count, last_inbound_at, last_outbound_at, next_action_at, summary, created_at, updated_at, leads(title)",
      { count: "exact" },
    )
    .order("updated_at", { ascending: false })
    .limit(LIMIT);

  if (statusFilter === "open") {
    query = query.in("status", OPEN_STATUSES);
  } else if (statusFilter === "handoff") {
    query = query.in("status", HANDOFF_STATUSES);
  } else if (statusFilter && statusFilter in STATUS_META) {
    query = query.eq("status", statusFilter);
  }

  if (channelFilter) query = query.eq("channel", channelFilter);

  const { data, count, error } = await query;
  const rows = (data ?? []) as Row[];

  const fieldClass =
    "rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] focus-ring";

  return (
    <section className="space-y-6">
      <PageHeader
        title="Conversaciones"
        subtitle="Todas las charlas que el agente mantiene con los leads. Ordenadas por actividad reciente."
        actions={
          <span className="text-sm text-[var(--muted)]">
            {count ?? rows.length}{" "}
            {(count ?? rows.length) === 1 ? "conversación" : "conversaciones"}
          </span>
        }
      />

      {/* Filtros: form GET, cada filtro queda en la URL. */}
      <form
        method="get"
        action="/conversations"
        className="flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3"
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Estado
          <select name="status" defaultValue={statusFilter} className={fieldClass}>
            {STATUS_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
          Canal
          <select name="channel" defaultValue={channelFilter} className={fieldClass}>
            {CHANNEL_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="inline-flex items-center rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] focus-ring"
        >
          Filtrar
        </button>
        {(statusFilter || channelFilter) && (
          <Link
            href="/conversations"
            className="inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] focus-ring"
          >
            Limpiar
          </Link>
        )}
      </form>

      {error ? (
        <ErrorNote>No se pudieron cargar las conversaciones: {error.message}</ErrorNote>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No hay conversaciones todavía"
          description="Cuando el autopilot contacte un lead o entre una respuesta, las charlas van a aparecer acá."
          icon={
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
      ) : (
        <>
          {/* Tabla (desktop) */}
          <Card className="hidden overflow-hidden lg:block">
            <div className="overflow-x-auto scroll-elegant">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                    <th className="px-4 py-3 font-medium">Canal</th>
                    <th className="px-4 py-3 font-medium">Contacto / Lead</th>
                    <th className="px-4 py-3 font-medium">Etapa</th>
                    <th className="px-4 py-3 font-medium">Interés</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Actividad</th>
                    <th className="px-4 py-3 text-right font-medium">Autopilot</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const lastAt = row.last_inbound_at ?? row.last_outbound_at;
                    const due = relativeFuture(row.next_action_at);
                    return (
                      <tr
                        key={row.id}
                        className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)]"
                      >
                        <td className="px-4 py-3 align-top">
                          <ChannelBadge channel={row.channel} />
                        </td>
                        <td className="max-w-xs px-4 py-3 align-top">
                          <Link
                            href={`/conversations/${row.id}`}
                            className="font-medium text-[var(--foreground)] hover:text-[var(--accent)] hover:underline"
                          >
                            {row.contact_handle || `Lead #${row.lead_id}`}
                          </Link>
                          <p className="truncate text-xs text-[var(--muted)]">
                            {leadTitle(row)}
                          </p>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <StageBadge stage={row.stage} />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <InterestMeter value={row.interest_level} compact />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="space-y-1">
                            <StatusBadge status={row.status} />
                            {row.next_action_at && due.overdue && (
                              <p className="text-xs font-medium text-[var(--danger-soft-fg)]">
                                Follow-up {due.text}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top whitespace-nowrap text-xs text-[var(--muted)]">
                          {relativeTime(lastAt)}
                          <span className="block text-[var(--subtle)]">
                            {row.message_count} msj
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right align-top">
                          <div className="flex justify-end">
                            <AutopilotToggle
                              conversationId={row.id}
                              on={row.autopilot}
                              size="sm"
                              label={false}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Tarjetas (mobile / tablet) */}
          <ul className="space-y-3 lg:hidden">
            {rows.map((row) => {
              const lastAt = row.last_inbound_at ?? row.last_outbound_at;
              const due = relativeFuture(row.next_action_at);
              return (
                <Card as="li" key={row.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/conversations/${row.id}`} className="min-w-0">
                      <div className="flex items-center gap-2">
                        <ChannelBadge channel={row.channel} />
                        {isHandoff(row.status) && <Badge tone="info">Handoff</Badge>}
                      </div>
                      <p className="mt-1.5 truncate font-medium text-[var(--foreground)]">
                        {row.contact_handle || `Lead #${row.lead_id}`}
                      </p>
                      <p className="truncate text-xs text-[var(--muted)]">
                        {leadTitle(row)}
                      </p>
                    </Link>
                    <AutopilotToggle
                      conversationId={row.id}
                      on={row.autopilot}
                      size="sm"
                      label={false}
                    />
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <StatusBadge status={row.status} />
                    <StageBadge stage={row.stage} />
                    <span className="ml-auto text-xs text-[var(--subtle)]">
                      {relativeTime(lastAt)}
                    </span>
                  </div>
                  <div className="mt-3">
                    <InterestMeter value={row.interest_level} />
                  </div>
                  {row.next_action_at && due.overdue && (
                    <p className="mt-2 text-xs font-medium text-[var(--danger-soft-fg)]">
                      Follow-up {due.text}
                    </p>
                  )}
                </Card>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

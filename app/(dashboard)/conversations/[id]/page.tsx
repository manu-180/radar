/**
 * Thread de una conversación: `/conversations/[id]`.
 *
 * Es la pieza central del panel. Server Component que lee la conversación, su
 * lead y todos los mensajes con el cliente admin. Renderiza un chat (burbujas
 * alineadas por `direction`, estilizadas por `role`; los eventos `system` van
 * como notas centradas) más un panel lateral con la info del lead, el medidor de
 * interés, la etapa, los contadores y los botones de acción. Lo interactivo
 * —composer, toggle de autopilot, marcar ganado/perdido, pausar— vive en islas
 * de cliente.
 *
 * Esta ruta es la que enlazan los avisos de WhatsApp del handoff
 * (`${APP_URL}/conversations/[id]`), así que el segmento no puede renombrarse.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getAdminClient } from "@/lib/supabase/admin";
import { sourceDisplayName } from "@/lib/sources/display";
import type { Conversation, Lead, Message } from "@/types/autopilot";

import {
  Badge,
  Card,
  ChannelBadge,
  formatCostFine,
  formatDateTime,
  formatTime,
  InterestMeter,
  isHandoff,
  relativeFuture,
  relativeTime,
  StageBadge,
  STAGE_META,
  STAGE_ORDER,
  StatusBadge,
} from "../../ui";
import { AutopilotToggle } from "../autopilot-toggle";
import { Composer } from "./composer";
import { ConversationActions } from "./conversation-actions";

export const metadata: Metadata = { title: "Conversación" };

export const dynamic = "force-dynamic";

/** Etiqueta corta del autor de un mensaje saliente según su `role`. */
const ROLE_LABEL: Record<string, string> = {
  agent: "Agente",
  owner: "Vos",
  lead: "Lead",
  system: "Sistema",
};

/** Una fila etiqueta/valor del panel lateral. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-[var(--subtle)]">
        {label}
      </dt>
      <dd className="text-right text-sm text-[var(--foreground)]">{children}</dd>
    </div>
  );
}

/** Progreso por etapas del embudo: barra de pasos con la actual resaltada. */
function StageProgress({ current }: { current: string }) {
  const idx = STAGE_ORDER.indexOf(current as (typeof STAGE_ORDER)[number]);
  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {STAGE_ORDER.map((stage, i) => (
          <span
            key={stage}
            title={STAGE_META[stage].label}
            className={`h-1.5 flex-1 rounded-full ${
              i <= idx ? "bg-[var(--accent)]" : "bg-[var(--surface-2)]"
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-[var(--muted)]">
        Etapa actual:{" "}
        <span className="font-medium text-[var(--foreground)]">
          {STAGE_META[current as (typeof STAGE_ORDER)[number]]?.label ?? current}
        </span>
      </p>
    </div>
  );
}

/**
 * Burbuja de un mensaje. Los `system` se muestran como nota centrada; el resto
 * se alinea por `direction` (inbound izq, outbound der) y se tiñe por `role`.
 */
function MessageBubble({ message }: { message: Message }) {
  if (message.role === "system") {
    return (
      <li className="flex justify-center">
        <span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs text-[var(--muted)]">
          {message.body}
          <span className="ml-2 text-[var(--subtle)]">
            {formatTime(message.created_at)}
          </span>
        </span>
      </li>
    );
  }

  const outbound = message.direction === "outbound";
  const failed = message.status === "failed";
  const isOwner = message.role === "owner";

  // Saliente del agente: acento. Saliente del dueño: superficie con borde.
  // Entrante (lead): superficie-2.
  const bubble = outbound
    ? isOwner
      ? "bg-[var(--surface)] text-[var(--foreground)] border border-[var(--border-strong)]"
      : "bg-[var(--accent)] text-[var(--accent-fg)]"
    : "bg-[var(--surface-2)] text-[var(--foreground)]";

  return (
    <li className={`flex flex-col ${outbound ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[78%] rounded-2xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words ${bubble} ${
          outbound ? "rounded-br-sm" : "rounded-bl-sm"
        }`}
      >
        {message.body}
      </div>
      <div
        className={`mt-1 flex items-center gap-2 px-1 text-[11px] text-[var(--subtle)] ${
          outbound ? "flex-row-reverse" : ""
        }`}
      >
        <span>{ROLE_LABEL[message.role] ?? message.role}</span>
        <span aria-hidden>·</span>
        <span>{formatTime(message.created_at)}</span>
        {outbound &&
          (failed ? (
            <span className="font-medium text-[var(--danger-soft-fg)]">
              · no se envió
            </span>
          ) : (
            <span aria-hidden title="Enviado">
              ✓
            </span>
          ))}
      </div>
    </li>
  );
}

export default async function ConversationThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const convId = Number(id);
  if (!Number.isInteger(convId) || convId <= 0) notFound();

  const db = getAdminClient();

  const { data: convRow, error } = await db
    .from("conversations")
    .select("*")
    .eq("id", convId)
    .maybeSingle();

  if (error) {
    return (
      <section className="space-y-4">
        <BackLink />
        <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2.5 text-sm text-[var(--danger-soft-fg)]">
          No se pudo cargar la conversación: {error.message}
        </p>
      </section>
    );
  }
  if (!convRow) notFound();
  const conv = convRow as Conversation;

  // Lead y mensajes en paralelo (el lead puede no existir si se borró).
  const [leadRes, messagesRes] = await Promise.all([
    db.from("leads").select("*").eq("id", conv.lead_id).maybeSingle(),
    db
      .from("messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true }),
  ]);

  const lead = (leadRes.data as Lead | null) ?? null;
  const messages = (messagesRes.data ?? []) as Message[];

  // Brief del handoff: el último evento `system` con "HANDOFF" o, si no, el summary.
  const handoffEvent = [...messages]
    .reverse()
    .find((m) => m.role === "system" && m.body.toUpperCase().includes("HANDOFF"));
  const handoffBrief =
    conv.summary?.trim() ||
    handoffEvent?.body.replace(/^HANDOFF[^:]*:\s*/i, "").trim() ||
    "";

  const totalCost = messages.reduce((s, m) => s + (m.ai_cost_usd ?? 0), 0);
  const due = relativeFuture(conv.next_action_at);
  const lastActivity =
    conv.last_inbound_at ?? conv.last_outbound_at ?? conv.updated_at;
  const leadBody = lead?.body?.trim() ?? "";
  const bodyExcerpt =
    leadBody.length > 280 ? `${leadBody.slice(0, 280)}…` : leadBody;

  return (
    <section className="space-y-5">
      <div className="space-y-3">
        <BackLink />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--foreground)]">
              {conv.contact_handle || `Lead #${conv.lead_id}`}
            </h1>
            <ChannelBadge channel={conv.channel} />
            <StatusBadge status={conv.status} />
          </div>
          <AutopilotToggle conversationId={conv.id} on={conv.autopilot} />
        </div>
      </div>

      {/* Banner de handoff: prominente, sólo si el lead pidió avanzar. */}
      {isHandoff(conv.status) && (
        <Card className="border-[var(--info-solid)]/40 bg-[var(--info-soft)] p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--info-solid)] text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                <path d="M17 11V3H7v8M5 11h14l1 10H4l1-10ZM9 15h6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-[var(--info-soft-fg)]">
                Este lead pidió avanzar
              </p>
              <p className="mt-0.5 text-sm text-[var(--info-soft-fg)]/90">
                El agente lo derivó para que sigas vos. Revisá lo que pidió y
                respondé desde el chat de abajo.
              </p>
              {handoffBrief && (
                <div className="mt-3 rounded-lg bg-[var(--surface)]/70 p-3 text-sm text-[var(--foreground)]">
                  <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Qué quiere
                  </p>
                  <p className="whitespace-pre-wrap">{handoffBrief}</p>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        {/* ===== Chat ===== */}
        <Card className="order-2 flex h-[calc(100vh-15rem)] min-h-[480px] flex-col overflow-hidden lg:order-1">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
            <span className="text-sm font-medium text-[var(--foreground)]">
              Conversación
            </span>
            <span className="text-xs text-[var(--subtle)]">
              {messages.length} {messages.length === 1 ? "mensaje" : "mensajes"}
            </span>
          </div>

          {messages.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-[var(--muted)]">
              Todavía no hay mensajes en esta conversación.
            </div>
          ) : (
            <ul className="flex-1 space-y-3 overflow-y-auto scroll-elegant p-4">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
            </ul>
          )}

          <Composer conversationId={conv.id} autopilotOn={conv.autopilot} />
        </Card>

        {/* ===== Panel lateral ===== */}
        <div className="order-1 space-y-4 lg:order-2">
          {/* Acciones */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-[var(--foreground)]">
              Acciones
            </h2>
            <ConversationActions conversationId={conv.id} status={conv.status} />
          </Card>

          {/* Estado de la conversación */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-[var(--foreground)]">
              Estado
            </h2>
            <div className="space-y-3">
              <InterestMeter value={conv.interest_level} />
              <StageProgress current={conv.stage} />
            </div>
            <dl className="mt-3 divide-y divide-[var(--border)] border-t border-[var(--border)] pt-1">
              <Field label="Etapa">
                <StageBadge stage={conv.stage} />
              </Field>
              <Field label="Mensajes">
                <span className="tabular-nums">
                  {conv.message_count}{" "}
                  <span className="text-[var(--subtle)]">
                    ({conv.outbound_count} salientes)
                  </span>
                </span>
              </Field>
              <Field label="Costo IA">
                <span className="tabular-nums">{formatCostFine(totalCost)}</span>
              </Field>
              <Field label="Próximo follow-up">
                {conv.next_action_at ? (
                  <span
                    className={
                      due.overdue ? "font-medium text-[var(--danger-soft-fg)]" : ""
                    }
                  >
                    {due.text}
                  </span>
                ) : (
                  <span className="text-[var(--subtle)]">sin agendar</span>
                )}
              </Field>
              <Field label="Última actividad">{relativeTime(lastActivity)}</Field>
              <Field label="Creada">{formatDateTime(conv.created_at)}</Field>
            </dl>
          </Card>

          {/* Resumen del agente */}
          {conv.summary?.trim() && (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold text-[var(--foreground)]">
                Resumen
              </h2>
              <p className="whitespace-pre-wrap text-sm text-[var(--muted)]">
                {conv.summary}
              </p>
            </Card>
          )}

          {/* Info del lead */}
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--foreground)]">
                Lead
              </h2>
              <Link
                href={`/leads/${conv.lead_id}`}
                className="text-xs font-medium text-[var(--accent)] hover:underline focus-ring"
              >
                Ver ficha →
              </Link>
            </div>
            {lead ? (
              <div className="space-y-3">
                <p className="text-sm font-medium text-[var(--foreground)]">
                  {lead.title?.trim() || "(lead sin título)"}
                </p>
                {bodyExcerpt && (
                  <p className="whitespace-pre-wrap text-sm text-[var(--muted)]">
                    {bodyExcerpt}
                  </p>
                )}
                <dl className="divide-y divide-[var(--border)] border-t border-[var(--border)] pt-1">
                  <Field label="Fuente">{sourceDisplayName(lead.source)}</Field>
                  <Field label="Contacto">
                    {conv.contact_handle || "—"}
                  </Field>
                  {lead.score !== null && (
                    <Field label="Score">
                      <span className="tabular-nums">{lead.score}/100</span>
                    </Field>
                  )}
                  {lead.category && (
                    <Field label="Categoría">
                      <Badge
                        tone={
                          lead.category === "hiring"
                            ? "ok"
                            : lead.category === "maybe"
                              ? "warn"
                              : "neutral"
                        }
                        dot={false}
                      >
                        {lead.category}
                      </Badge>
                    </Field>
                  )}
                </dl>
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
              </div>
            ) : (
              <p className="text-sm text-[var(--subtle)]">
                El lead asociado ya no está disponible.
              </p>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}

/** Enlace de vuelta a la lista de conversaciones. */
function BackLink() {
  return (
    <Link
      href="/conversations"
      className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)] focus-ring"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
        <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Volver a conversaciones
    </Link>
  );
}

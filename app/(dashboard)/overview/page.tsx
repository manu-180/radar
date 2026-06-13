/**
 * Resumen: `/overview` — la pantalla de aterrizaje del panel.
 *
 * Server Component que arma la foto del momento con el cliente admin de
 * Supabase: KPIs (conversaciones activas, lo que espera al dueño, handoffs
 * pendientes, leads y conversaciones de hoy, costo de IA), un embudo de leads →
 * handoffs y un feed de actividad reciente. Los handoffs van destacados: son lo
 * que necesita la atención de Manuel.
 *
 * Render dinámico: los números reflejan el estado vivo de la base, no una
 * versión cacheada.
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
  formatUsd,
  InterestMeter,
  isHandoff,
  KpiCard,
  PageHeader,
  relativeFuture,
  relativeTime,
  StatusBadge,
} from "../ui";

export const metadata: Metadata = { title: "Resumen" };

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

type SupabaseClientLike = ReturnType<typeof getAdminClient>;

/**
 * Cuenta filas de una tabla aplicando un narrowing. El cliente admin es sin
 * tipar, así que el builder se trata como `any` (igual que el resto del código
 * que castea sus resultados); devuelve 0 ante error.
 */
async function countWhere(
  db: SupabaseClientLike,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apply: (q: any) => any,
): Promise<number> {
  const base = db.from(table).select("*", { count: "exact", head: true });
  const { count } = (await apply(base)) as { count: number | null };
  return count ?? 0;
}

/** Ícono SVG inline para las tarjetas KPI. */
function Glyph({ d, fill = false }: { d: string; fill?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** Una fila del embudo del Resumen (etiqueta + valor + barra proporcional). */
function FunnelRow({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-[var(--muted)]">{label}</span>
        <span className="tabular-nums text-[var(--subtle)]">
          <span className="font-semibold text-[var(--foreground)]">{value}</span>{" "}
          · {pct}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div
          className="h-full rounded-full bg-[var(--accent)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </li>
  );
}

/**
 * Cortes temporales del overview. Va en una función aparte porque `Date.now()`
 * no puede llamarse en el cuerpo de render de un componente (regla
 * `react-hooks/purity`); acá es código común, no render.
 */
function timeCutoffs(): { todayCut: string; cut30: string } {
  const now = Date.now();
  return {
    todayCut: new Date(now - DAY_MS).toISOString(),
    cut30: new Date(now - 30 * DAY_MS).toISOString(),
  };
}

export default async function OverviewPage() {
  const db = getAdminClient();
  const { todayCut, cut30 } = timeCutoffs();

  const OPEN: ConversationStatus[] = ["active", "awaiting_reply"];
  const HANDOFF: ConversationStatus[] = ["wants_draft", "handed_off"];

  const [
    activeCount,
    awaitingOwnerCount,
    handoffCount,
    leadsToday,
    convsToday,
    // embudo
    leadsDetected,
    leadsClassified,
    leadsEngaged,
    leadsResponded,
    handoffsTotal,
    // feeds
    recentConvsRes,
    handoffConvsRes,
    // costo IA
    leadCostRes,
    msgCostRes,
  ] = await Promise.all([
    countWhere(db, "conversations", (q) => q.in("status", OPEN)),
    countWhere(db, "conversations", (q) => q.eq("status", "awaiting_owner")),
    countWhere(db, "conversations", (q) => q.in("status", HANDOFF)),
    countWhere(db, "leads", (q) => q.gte("first_seen_at", todayCut)),
    countWhere(db, "conversations", (q) => q.gte("created_at", todayCut)),

    countWhere(db, "leads", (q) => q),
    countWhere(db, "leads", (q) => q.eq("llm_status", "done")),
    countWhere(db, "leads", (q) => q.in("engage_status", ["engaging", "engaged"])),
    countWhere(db, "conversations", (q) => q.not("last_inbound_at", "is", null)),
    countWhere(db, "conversations", (q) =>
      q.in("status", [...HANDOFF, "won"]),
    ),

    db
      .from("conversations")
      .select(
        "id, lead_id, channel, contact_handle, status, stage, interest_level, autopilot, message_count, last_inbound_at, last_outbound_at, next_action_at, updated_at, leads(title)",
      )
      .order("updated_at", { ascending: false })
      .limit(8),
    db
      .from("conversations")
      .select(
        "id, lead_id, channel, contact_handle, status, stage, interest_level, updated_at, leads(title)",
      )
      .in("status", HANDOFF)
      .order("updated_at", { ascending: false })
      .limit(6),

    db
      .from("leads")
      .select("llm_cost_usd")
      .not("llm_cost_usd", "is", null)
      .gte("first_seen_at", cut30)
      .limit(10_000),
    db
      .from("messages")
      .select("ai_cost_usd")
      .not("ai_cost_usd", "is", null)
      .gte("created_at", cut30)
      .limit(10_000),
  ]);

  type RecentRow = Conversation & {
    leads: { title: string | null } | { title: string | null }[] | null;
  };
  const recentConvs = (recentConvsRes.data ?? []) as RecentRow[];
  const handoffConvs = (handoffConvsRes.data ?? []) as RecentRow[];

  const leadCost = ((leadCostRes.data ?? []) as { llm_cost_usd: number }[]).reduce(
    (s, r) => s + (r.llm_cost_usd ?? 0),
    0,
  );
  const msgCost = ((msgCostRes.data ?? []) as { ai_cost_usd: number }[]).reduce(
    (s, r) => s + (r.ai_cost_usd ?? 0),
    0,
  );
  const aiCost30 = leadCost + msgCost;

  const funnelMax = Math.max(1, leadsDetected);

  function title(row: RecentRow): string {
    const l = row.leads;
    const t = Array.isArray(l) ? l[0]?.title : l?.title;
    return t?.trim() || `Lead #${row.lead_id}`;
  }

  return (
    <section className="space-y-7">
      <PageHeader
        title="Resumen"
        subtitle="La foto del momento: qué está pasando y qué necesita tu atención."
      />

      {/* ===== KPIs ===== */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard
          label="Handoffs pendientes"
          value={handoffCount}
          hint="leads que pidieron avanzar"
          tone="info"
          emphasis
          href="/conversations?status=handoff"
          icon={<Glyph d="M17 11V3H7v8M5 11h14l1 10H4l1-10ZM9 15h6" />}
        />
        <KpiCard
          label="Te toca responder"
          value={awaitingOwnerCount}
          tone="warn"
          href="/conversations?status=awaiting_owner"
          icon={<Glyph d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z" />}
        />
        <KpiCard
          label="Conversaciones activas"
          value={activeCount}
          tone="ok"
          href="/conversations?status=open"
          icon={<Glyph d="M22 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 22 11.5Z" />}
        />
        <KpiCard
          label="Leads hoy"
          value={leadsToday}
          tone="accent"
          href="/leads"
          icon={<Glyph d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />}
        />
        <KpiCard
          label="Charlas hoy"
          value={convsToday}
          tone="accent"
          icon={<Glyph d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3" />}
        />
        <KpiCard
          label="Costo IA · 30 d"
          value={formatUsd(aiCost30)}
          hint="clasificación + charlas"
          tone="neutral"
          href="/metrics"
          icon={<Glyph d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        {/* ===== Embudo ===== */}
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">
            Embudo
          </h2>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            De leads detectados a handoffs. Dónde se gana y se pierde valor.
          </p>
          <ul className="mt-4 space-y-3">
            <FunnelRow label="Detectados" value={leadsDetected} max={funnelMax} />
            <FunnelRow
              label="Clasificados por IA"
              value={leadsClassified}
              max={funnelMax}
            />
            <FunnelRow label="Enganchados" value={leadsEngaged} max={funnelMax} />
            <FunnelRow
              label="Respondieron"
              value={leadsResponded}
              max={funnelMax}
            />
            <FunnelRow
              label="Handoffs + ganados"
              value={handoffsTotal}
              max={funnelMax}
            />
          </ul>
        </Card>

        {/* ===== Handoffs pendientes (destacado) ===== */}
        <Card className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[var(--foreground)]">
                Handoffs pendientes
              </h2>
              <p className="mt-0.5 text-xs text-[var(--muted)]">
                Leads que pidieron avanzar y esperan que sigas vos.
              </p>
            </div>
            {handoffConvs.length > 0 && (
              <Link
                href="/conversations?status=handoff"
                className="text-xs font-medium text-[var(--accent)] hover:underline focus-ring"
              >
                Ver todos →
              </Link>
            )}
          </div>

          {handoffConvs.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                title="Sin handoffs pendientes"
                description="Cuando un lead pida un boceto o presupuesto, va a aparecer acá para que lo atiendas."
                icon={
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
                    <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                }
              />
            </div>
          ) : (
            <ul className="mt-4 space-y-2">
              {handoffConvs.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/conversations/${c.id}`}
                    className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 transition-colors hover:border-[var(--info-solid)]/40 hover:bg-[var(--info-soft)]/40 focus-ring"
                  >
                    <ChannelBadge channel={c.channel} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--foreground)]">
                        {c.contact_handle || `Lead #${c.lead_id}`}
                      </p>
                      <p className="truncate text-xs text-[var(--muted)]">
                        {title(c)}
                      </p>
                    </div>
                    <div className="hidden w-24 sm:block">
                      <InterestMeter value={c.interest_level} compact />
                    </div>
                    <span className="text-xs text-[var(--subtle)]">
                      {relativeTime(c.updated_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* ===== Actividad reciente ===== */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">
          Actividad reciente
        </h2>
        <p className="mt-0.5 text-xs text-[var(--muted)]">
          Las conversaciones con movimiento más reciente.
        </p>

        {recentConvs.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Sin actividad todavía"
              description="Cuando empiecen las conversaciones, vas a ver el movimiento acá."
            />
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--border)]">
            {recentConvs.map((c) => {
              const lastAt = c.last_inbound_at ?? c.last_outbound_at ?? c.updated_at;
              const due = relativeFuture(c.next_action_at);
              return (
                <li key={c.id}>
                  <Link
                    href={`/conversations/${c.id}`}
                    className="flex items-center gap-3 py-3 transition-colors hover:bg-[var(--surface-2)] focus-ring -mx-2 rounded-lg px-2"
                  >
                    <ChannelBadge channel={c.channel} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[var(--foreground)]">
                        {c.contact_handle || `Lead #${c.lead_id}`}
                        <span className="ml-2 font-normal text-[var(--muted)]">
                          {title(c)}
                        </span>
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        <StatusBadge status={c.status} />
                        {isHandoff(c.status) && <Badge tone="info">Handoff</Badge>}
                        {c.next_action_at && due.overdue && (
                          <span className="text-xs font-medium text-[var(--danger-soft-fg)]">
                            follow-up {due.text}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-[var(--subtle)]">
                      {relativeTime(lastAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </section>
  );
}

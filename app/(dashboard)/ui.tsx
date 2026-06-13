/**
 * Kit visual compartido del command-center.
 *
 * Reúne en un solo lugar lo que las cinco superficies del panel (Resumen,
 * Conversaciones, thread, Leads, Configuración) comparten: tokens de color por
 * estado/etapa, badges, el medidor de interés, los íconos de canal (SVG inline,
 * sin librerías), las tarjetas KPI y los formateadores de plata y tiempo. Tener
 * una sola fuente de verdad evita que las vistas se desincronicen y mantiene la
 * estética unificada.
 *
 * Es un módulo de presentación puro: no toca la base ni importa server-only, así
 * que lo pueden usar tanto Server Components como islas de cliente.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import type {
  Channel,
  ConversationStage,
  ConversationStatus,
} from "@/types/autopilot";

// ─── formateadores ───────────────────────────────────────────────────────────

/** Plata en dólares: 4 decimales para costos chicos, 2 si llega a $1. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  return `$${n.toFixed(n !== 0 && n < 1 ? 4 : 2)}`;
}

/** Costo fino de IA por mensaje/lead, con más precisión (`$0.0123`). */
export function formatCostFine(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  return `$${n.toFixed(4)}`;
}

/** Fecha + hora corta en español rioplatense. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Solo la hora (para timestamps dentro del chat). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Antigüedad en lenguaje natural ("hace 5 min", "hace 2 d"). */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 0) return "en breve";
  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `hace ${days} d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `hace ${months} mes${months === 1 ? "" : "es"}`;
  return `hace ${Math.floor(months / 12)} a`;
}

/** Tiempo relativo hacia el futuro ("en 3 h"); negativo => vencido. */
export function relativeFuture(iso: string | null | undefined): {
  text: string;
  overdue: boolean;
} {
  if (!iso) return { text: "—", overdue: false };
  const diff = new Date(iso).getTime() - Date.now();
  const overdue = diff < 0;
  const minutes = Math.floor(Math.abs(diff) / 60_000);
  let text: string;
  if (minutes < 1) text = "ahora";
  else if (minutes < 60) text = `${minutes} min`;
  else if (minutes < 1440) text = `${Math.floor(minutes / 60)} h`;
  else text = `${Math.floor(minutes / 1440)} d`;
  return { text: overdue ? `vencido hace ${text}` : `en ${text}`, overdue };
}

// ─── estado / etapa de conversación ──────────────────────────────────────────

type Tone = "ok" | "warn" | "danger" | "info" | "accent" | "neutral";

/** Mapea cada estado de conversación a un tono y una etiqueta legible. */
export const STATUS_META: Record<
  ConversationStatus,
  { label: string; tone: Tone }
> = {
  pending_outreach: { label: "Por contactar", tone: "neutral" },
  awaiting_reply: { label: "Esperando respuesta", tone: "warn" },
  active: { label: "Activa", tone: "ok" },
  awaiting_owner: { label: "Te toca responder", tone: "info" },
  snoozed: { label: "En pausa temporal", tone: "neutral" },
  wants_draft: { label: "Pidió avanzar", tone: "info" },
  handed_off: { label: "Derivada a vos", tone: "info" },
  won: { label: "Ganado", tone: "ok" },
  lost: { label: "Perdido", tone: "danger" },
  disqualified: { label: "Descartada", tone: "neutral" },
  paused: { label: "Pausada", tone: "neutral" },
  failed: { label: "Falló", tone: "danger" },
};

/** Etapas del embudo dentro de una conversación, en orden, con etiqueta. */
export const STAGE_META: Record<ConversationStage, { label: string }> = {
  outreach: { label: "Contacto" },
  greeted: { label: "Saludo" },
  discovery: { label: "Descubrimiento" },
  offer: { label: "Propuesta" },
  negotiation: { label: "Negociación" },
  scheduling: { label: "Agenda" },
  draft_requested: { label: "Pidió boceto" },
  closed: { label: "Cerrada" },
};

/** Orden del embudo, para dibujar el progreso por etapas. */
export const STAGE_ORDER: ConversationStage[] = [
  "outreach",
  "greeted",
  "discovery",
  "offer",
  "negotiation",
  "scheduling",
  "draft_requested",
  "closed",
];

/** `true` si el estado representa un handoff que necesita al dueño. */
export function isHandoff(status: ConversationStatus): boolean {
  return status === "wants_draft" || status === "handed_off";
}

// ─── primitivos visuales ─────────────────────────────────────────────────────

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-[var(--ok-soft)] text-[var(--ok-soft-fg)]",
  warn: "bg-[var(--warn-soft)] text-[var(--warn-soft-fg)]",
  danger: "bg-[var(--danger-soft)] text-[var(--danger-soft-fg)]",
  info: "bg-[var(--info-soft)] text-[var(--info-soft-fg)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]",
  neutral: "bg-[var(--neutral-soft)] text-[var(--neutral-soft-fg)]",
};

const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-[var(--ok-solid)]",
  warn: "bg-[var(--warn-solid)]",
  danger: "bg-[var(--danger-solid)]",
  info: "bg-[var(--info-solid)]",
  accent: "bg-[var(--accent)]",
  neutral: "bg-[var(--subtle)]",
};

/** Pastilla de estado con punto de color. Tamaño `sm` por defecto. */
export function Badge({
  tone = "neutral",
  children,
  dot = true,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[tone]} ${className}`}
    >
      {dot && (
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${DOT_CLASS[tone]}`}
        />
      )}
      {children}
    </span>
  );
}

/** Badge ya resuelto desde un `ConversationStatus`. */
export function StatusBadge({ status }: { status: ConversationStatus }) {
  const meta = STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** Badge de etapa (tono acento, sin punto, más discreto). */
export function StageBadge({ stage }: { stage: ConversationStage }) {
  const meta = STAGE_META[stage] ?? { label: stage };
  return (
    <span className="inline-flex items-center rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
      {meta.label}
    </span>
  );
}

/**
 * Medidor de interés 0–100, color-graduado: rojo (frío) → ámbar → verde
 * (caliente). Accesible vía `role="meter"`. `compact` achica la altura para
 * filas de tabla.
 */
export function InterestMeter({
  value,
  compact = false,
}: {
  value: number | null | undefined;
  compact?: boolean;
}) {
  const v = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  const color =
    v >= 67
      ? "var(--ok-solid)"
      : v >= 34
        ? "var(--warn-solid)"
        : "var(--danger-solid)";
  return (
    <div
      className={compact ? "flex items-center gap-2" : "space-y-1"}
      role="meter"
      aria-valuenow={v}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Nivel de interés"
    >
      {!compact && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-[var(--muted)]">Interés</span>
          <span className="font-semibold tabular-nums text-[var(--foreground)]">
            {v}
          </span>
        </div>
      )}
      <div
        className={`${compact ? "h-1.5 w-20" : "h-2 w-full"} overflow-hidden rounded-full bg-[var(--surface-2)]`}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${v}%`, backgroundColor: color }}
        />
      </div>
      {compact && (
        <span className="text-xs font-semibold tabular-nums text-[var(--muted)]">
          {v}
        </span>
      )}
    </div>
  );
}

/** Barra horizontal simple (proporción value/max), tono configurable. */
export function Bar({
  value,
  max,
  tone = "accent",
}: {
  value: number;
  max: number;
  tone?: Tone;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
      <div
        className={`h-full rounded-full ${DOT_CLASS[tone]}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── tarjetas / superficies ──────────────────────────────────────────────────

/** Tarjeta base del panel: superficie, borde sutil, esquinas redondeadas. */
export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Tag
      className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] ${className}`}
    >
      {children}
    </Tag>
  );
}

/**
 * Tarjeta KPI: rótulo, número grande, pista opcional y, si se pasa `href`,
 * vuelve la tarjeta clickeable hacia esa ruta. `tone` tiñe el acento/realce.
 */
export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
  href,
  emphasis = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
  href?: string;
  emphasis?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          {label}
        </p>
        {icon && (
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE_CLASS[tone]}`}
          >
            {icon}
          </span>
        )}
      </div>
      <p
        className={`mt-2 font-semibold tabular-nums tracking-tight ${emphasis ? "text-3xl" : "text-2xl"} text-[var(--foreground)]`}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-[var(--subtle)]">{hint}</p>
      ) : null}
    </>
  );

  const base =
    "block rounded-xl border bg-[var(--surface)] p-4 transition-shadow";
  const ring = emphasis
    ? "border-[var(--accent)]/40 ring-1 ring-[var(--accent)]/20"
    : "border-[var(--border)]";

  if (href) {
    return (
      <Link
        href={href}
        className={`${base} ${ring} hover:border-[var(--accent)]/40 hover:shadow-md focus-ring`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={`${base} ${ring}`}>{inner}</div>;
}

/** Encabezado de página: título grande + subtítulo opcional + acciones. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--foreground)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm text-[var(--muted)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Estado vacío que se ve intencional: ícono opcional + título + texto. */
export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-6 py-14 text-center">
      {icon && (
        <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--subtle)]">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-[var(--foreground)]">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** Caja de error consistente (rojo suave). */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] px-3 py-2.5 text-sm text-[var(--danger-soft-fg)]">
      {children}
    </p>
  );
}

// ─── íconos de canal (SVG inline, sin librerías) ─────────────────────────────

/** Glifo de cada canal. `currentColor` para heredar el color del contenedor. */
export function ChannelGlyph({
  channel,
  className = "h-3.5 w-3.5",
}: {
  channel: Channel | string;
  className?: string;
}) {
  switch (channel) {
    case "telegram":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
          <path d="M21.94 4.6 18.7 19.86c-.24 1.08-.88 1.35-1.78.84l-4.92-3.63-2.37 2.29c-.27.27-.5.5-1 .5l.35-5.02 9.13-8.25c.4-.35-.09-.55-.62-.2L6.42 13.1l-4.86-1.52c-1.06-.33-1.08-1.06.22-1.57L20.6 3.06c.88-.32 1.65.2 1.34 1.54Z" />
        </svg>
      );
    case "whatsapp":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
          <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.2 8.2 0 0 1 2.42 5.82c0 4.54-3.7 8.24-8.25 8.24a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.11.82.83-3.04-.2-.31a8.18 8.18 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24Zm-2.84 4.4c-.16 0-.42.06-.64.3-.22.24-.84.82-.84 2 0 1.18.86 2.32.98 2.48.12.16 1.69 2.58 4.1 3.62.57.25 1.02.4 1.37.5.58.19 1.1.16 1.51.1.46-.07 1.42-.58 1.62-1.14.2-.56.2-1.04.14-1.14-.06-.1-.22-.16-.46-.28-.24-.12-1.42-.7-1.64-.78-.22-.08-.38-.12-.54.12-.16.24-.62.78-.76.94-.14.16-.28.18-.52.06-.24-.12-1.01-.37-1.93-1.19-.71-.64-1.19-1.42-1.33-1.66-.14-.24-.01-.37.11-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.54-1.3-.74-1.78-.2-.47-.4-.4-.54-.41-.14-.01-.3-.01-.46-.01Z" />
        </svg>
      );
    case "bluesky":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
          <path d="M6.34 4.2C8.7 5.97 11.23 9.57 12 11.5c.77-1.93 3.3-5.53 5.66-7.3 1.7-1.27 4.34-2.26 4.34.77 0 .6-.35 5.08-.55 5.8-.71 2.52-3.28 3.17-5.56 2.78 3.99.68 5 2.93 2.81 5.18-4.17 4.27-5.99-1.07-6.45-2.44-.09-.25-.13-.37-.13-.27 0-.1-.04.02-.13.27-.46 1.37-2.28 6.71-6.45 2.44-2.19-2.25-1.18-4.5 2.81-5.18-2.28.39-4.85-.26-5.56-2.78C2.35 9.45 2 4.97 2 4.37c0-3.03 2.64-2.04 4.34-.77Z" />
        </svg>
      );
    case "reddit":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
          <path d="M22 11.82a2.18 2.18 0 0 0-3.69-1.57 10.7 10.7 0 0 0-5.42-1.71l.92-4.34 3.02.64a1.56 1.56 0 1 0 .17-.97l-3.38-.72a.48.48 0 0 0-.57.37l-1.03 4.84a10.74 10.74 0 0 0-5.5 1.7 2.18 2.18 0 1 0-2.4 3.57 4.3 4.3 0 0 0-.05.66c0 3.36 3.91 6.08 8.73 6.08s8.73-2.72 8.73-6.08a4.2 4.2 0 0 0-.05-.65A2.18 2.18 0 0 0 22 11.82ZM7.4 13.38a1.56 1.56 0 1 1 3.12 0 1.56 1.56 0 0 1-3.12 0Zm8.7 4.13c-1.07 1.07-3.12 1.15-3.72 1.15-.6 0-2.65-.08-3.72-1.15a.4.4 0 0 1 .57-.57c.67.67 2.11.91 3.15.91 1.04 0 2.48-.24 3.15-.91a.4.4 0 1 1 .57.57Zm-.27-2.57a1.56 1.56 0 1 1 0-3.12 1.56 1.56 0 0 1 0 3.12Z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
          <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2Z" />
        </svg>
      );
  }
}

/** Tono de marca por canal, para teñir su chip. */
const CHANNEL_TONE: Record<string, Tone> = {
  telegram: "info",
  whatsapp: "ok",
  bluesky: "info",
  reddit: "warn",
};

/** Chip de canal con glifo + nombre. */
export function ChannelBadge({ channel }: { channel: Channel | string }) {
  const label =
    channel === "telegram"
      ? "Telegram"
      : channel === "whatsapp"
        ? "WhatsApp"
        : channel === "bluesky"
          ? "Bluesky"
          : channel === "reddit"
            ? "Reddit"
            : String(channel);
  const tone = CHANNEL_TONE[channel] ?? "neutral";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      <ChannelGlyph channel={channel} />
      {label}
    </span>
  );
}

// ─── clases de control reutilizables (islas de cliente) ──────────────────────

/** Input/select/textarea con foco accesible y look del panel. */
export const FIELD_CLASS =
  "rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--subtle)] focus-ring";

/** Botón primario (acento). */
export const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] focus-ring disabled:opacity-50 disabled:pointer-events-none";

/** Botón secundario (borde). */
export const SECONDARY_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--surface-2)] focus-ring disabled:opacity-50 disabled:pointer-events-none";

/** Botón de peligro sutil (borde rojo). */
export const DANGER_BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--danger-soft)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium text-[var(--danger-soft-fg)] transition-colors hover:bg-[var(--danger-soft)] focus-ring disabled:opacity-50 disabled:pointer-events-none";

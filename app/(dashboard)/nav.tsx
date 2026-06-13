"use client";

/**
 * Navegación lateral del command-center.
 *
 * Sidebar con secciones agrupadas y resaltado de la activa. En desktop es una
 * columna fija; en mobile colapsa detrás de un botón hamburguesa (estado local,
 * sin dependencias). Cada item lleva su glifo SVG inline. El acento marca la
 * sección activa con una barra a la izquierda + fondo suave.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";

/** Un item de navegación: ruta, etiqueta y glifo. */
interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** Rutas extra que también deben marcar este item como activo. */
  match?: string[];
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

const ITEMS: NavItem[] = [
  {
    href: "/overview",
    label: "Resumen",
    icon: <Icon d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z" />,
  },
  {
    href: "/conversations",
    label: "Conversaciones",
    icon: (
      <Icon d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7a8.5 8.5 0 0 1-.9-3.8A8.38 8.38 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5Z" />
    ),
  },
  {
    href: "/leads",
    label: "Leads",
    icon: (
      <Icon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-4a4 4 0 0 1 0 7.75" />
    ),
  },
  {
    href: "/metrics",
    label: "Métricas",
    icon: <Icon d="M3 3v18h18M7 15l3-3 3 3 5-6" />,
  },
  {
    href: "/config",
    label: "Configuración",
    icon: (
      <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-1.9-1.1l-.4-2.5H9.4L9 5.3a7.3 7.3 0 0 0-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 1.9 1.1l.4 2.5h4.2l.4-2.5a7.3 7.3 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.6c.07-.36.1-.73.1-1.1Z" />
    ),
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  const all = [item.href, ...(item.match ?? [])];
  return all.some((h) => pathname === h || pathname.startsWith(`${h}/`));
}

/** Lista de enlaces (compartida entre sidebar desktop y panel mobile). */
function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Secciones del panel">
      {ITEMS.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-[var(--accent-soft)] text-[var(--accent-soft-fg)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
            }`}
          >
            {active && (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[var(--accent)]"
              />
            )}
            <span
              className={
                active
                  ? "text-[var(--accent)]"
                  : "text-[var(--subtle)] group-hover:text-[var(--foreground)]"
              }
            >
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Logotipo de palabra del panel. */
function Wordmark() {
  return (
    <Link
      href="/overview"
      className="flex items-center gap-2.5 rounded-lg px-1 py-1 focus-ring"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--accent-fg)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
          <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.2 6.5 3.6L12 11.4 5.5 7.8 12 4.2Zm-7 5.1 6 3.4v6.8l-6-3.3V9.3Zm8 10.2v-6.8l6-3.4v6.9l-6 3.3Z" />
        </svg>
      </span>
      <span className="text-sm font-semibold tracking-tight text-[var(--foreground)]">
        Radar
      </span>
    </Link>
  );
}

/** Botón de logout (recibe la server action como prop desde el layout). */
function LogoutForm({ action }: { action: () => void }) {
  return (
    <form action={action}>
      <button
        type="submit"
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-[var(--muted)] transition-colors hover:bg-[var(--danger-soft)] hover:text-[var(--danger-soft-fg)] focus-ring"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[18px] w-[18px] shrink-0"
          aria-hidden
        >
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
        </svg>
        Cerrar sesión
      </button>
    </form>
  );
}

/** Sidebar de escritorio (columna fija). */
export function DashboardSidebar({ logout }: { logout: () => void }) {
  return (
    <aside className="hidden md:flex md:w-64 md:shrink-0 md:flex-col md:gap-6 md:border-r md:border-[var(--border)] md:bg-[var(--surface)] md:px-3 md:py-5">
      <div className="px-1">
        <Wordmark />
      </div>
      <div className="flex-1">
        <NavLinks />
      </div>
      <div className="border-t border-[var(--border)] pt-3">
        <LogoutForm action={logout} />
      </div>
    </aside>
  );
}

/** Barra superior + panel desplegable, solo en mobile. */
export function DashboardTopbar({ logout }: { logout: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <Wordmark />
        <button
          type="button"
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border-strong)] text-[var(--muted)] hover:bg-[var(--surface-2)] focus-ring"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            className="h-5 w-5"
            aria-hidden
          >
            {open ? (
              <path d="M18 6 6 18M6 6l12 12" />
            ) : (
              <path d="M3 12h18M3 6h18M3 18h18" />
            )}
          </svg>
        </button>
      </header>
      {open && (
        <div className="border-b border-[var(--border)] bg-[var(--surface)] px-3 py-3">
          <NavLinks onNavigate={() => setOpen(false)} />
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <LogoutForm action={logout} />
          </div>
        </div>
      )}
    </div>
  );
}

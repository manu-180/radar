"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Entradas de navegación del dashboard, en orden de aparición. */
const ITEMS = [
  { href: "/leads", label: "Leads" },
  { href: "/config", label: "Configuración" },
  { href: "/metrics", label: "Métricas" },
] as const;

/** Navegación del dashboard, con resaltado de la sección activa. */
export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {ITEMS.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              active
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

import { logout } from "./actions";
import { DashboardNav } from "./nav";

/**
 * Layout del dashboard: barra superior con navegación y botón de logout. El
 * grupo `(dashboard)` no afecta la URL — las páginas resuelven a `/leads`,
 * `/config` y `/metrics`. El acceso lo protege `proxy.ts`.
 */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold">Lead Detector</span>
          <DashboardNav />
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            Cerrar sesión
          </button>
        </form>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}

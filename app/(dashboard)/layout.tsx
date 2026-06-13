import { logout } from "./actions";
import { DashboardSidebar, DashboardTopbar } from "./nav";

/**
 * Shell del command-center.
 *
 * Sidebar fija a la izquierda en desktop; barra superior con menú desplegable en
 * mobile. El contenido vive en un `main` con ancho máximo y padding generoso. El
 * grupo `(dashboard)` no afecta la URL — las páginas resuelven a `/overview`,
 * `/conversations`, `/leads`, `/metrics` y `/config`. El acceso lo protege
 * `proxy.ts` (cookie `ld_session` firmada).
 */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <DashboardSidebar logout={logout} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DashboardTopbar logout={logout} />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}

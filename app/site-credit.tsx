/**
 * Crédito de autoría del sitio.
 *
 * Pie discreto que firma quién construyó el panel. Reusa los tokens del
 * command-center (`surface`, `border`, `muted`, `accent`, fuente mono) para que
 * se sienta nativo y no como una barra pegada. El enlace a APEX es real,
 * visible y `dofollow` (sólo `rel="noopener"`); el monograma es decorativo
 * (`aria-hidden`) y el texto accesible vive en el propio `<a>`.
 *
 * Se monta en el layout raíz, así que aparece al pie de cada vista —incluida la
 * pantalla pública de acceso— empujado hacia abajo por el `flex flex-col` del
 * body. Sin recursos externos; la única transición es de color, por lo que
 * `prefers-reduced-motion` no se ve afectado.
 */
export function SiteCredit() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-auto border-t border-[var(--border)] bg-[var(--surface)]">
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center justify-between gap-2 px-4 py-4 text-center sm:flex-row sm:px-6 sm:text-left lg:px-8">
        <p className="font-mono text-[11px] leading-none tracking-wide text-[var(--subtle)]">
          © {year} Lead Detector
        </p>

        <a
          href="https://www.theapexweb.com"
          target="_blank"
          rel="noopener nofollow"
          className="group inline-flex items-center gap-2 font-mono text-[11px] leading-none tracking-wide text-[var(--muted)] transition-colors hover:text-[var(--accent)]"
        >
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 items-center justify-center rounded-[4px] bg-[var(--accent-soft)] text-[9px] font-semibold text-[var(--accent-soft-fg)] transition-colors group-hover:bg-[var(--accent)] group-hover:text-[var(--accent-fg)]"
          >
            A
          </span>
          <span>
            Desarrollo web ·{" "}
            <span className="text-[var(--foreground)] group-hover:text-[var(--accent)]">
              APEX
            </span>
          </span>
        </a>
      </div>
    </footer>
  );
}

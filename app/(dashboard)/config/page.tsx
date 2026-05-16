/**
 * Panel de Configuración: `/config`.
 *
 * Server Component que lee la config manejada por datos del detector. En este
 * paso cubre la sección de **keywords** del pre-filtro (paso 05): listarlas,
 * agregarlas, editarlas, activarlas/desactivarlas y borrarlas sin tocar código.
 * Los pasos siguientes le suman las fuentes y los ajustes generales.
 *
 * La página es dinámica: siempre refleja el estado actual de la tabla, y cada
 * server action revalida `/config` para que el cambio se vea al instante.
 */

import { getAdminClient } from "@/lib/supabase/admin";

import type { KeywordKind, KeywordLang } from "./actions";
import { AddKeywordForm, type Keyword, KeywordRow } from "./keywords";

/** Render dinámico: la config no se cachea, se lee fresca en cada request. */
export const dynamic = "force-dynamic";

/** Las dos secciones de keywords, en orden, con su título y descripción. */
const KIND_GROUPS: { kind: KeywordKind; title: string; description: string }[] =
  [
    {
      kind: "include",
      title: "Inclusión",
      description:
        "Un item avanza a la IA sólo si su texto contiene al menos una de estas keywords.",
    },
    {
      kind: "exclude",
      title: "Exclusión",
      description:
        "Si el texto de un item contiene alguna de estas keywords, se descarta antes de la IA.",
    },
  ];

/** Idiomas en orden de aparición, con su etiqueta legible. */
const LANG_GROUPS: { lang: KeywordLang; label: string }[] = [
  { lang: "any", label: "Cualquier idioma" },
  { lang: "es", label: "Español" },
  { lang: "en", label: "Inglés" },
];

export default async function ConfigPage() {
  const { data, error } = await getAdminClient()
    .from("keywords")
    .select("id, term, kind, lang, enabled")
    .order("term");

  const keywords = (data ?? []) as Keyword[];

  return (
    <section className="max-w-3xl space-y-8">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Configuración</h1>
        <p className="text-sm text-zinc-500">
          Ajustes del detector manejados por datos. Los cambios impactan en el
          próximo poll.
        </p>
      </div>

      {/* --- Sección: keywords del pre-filtro --- */}
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-900">
            Keywords del pre-filtro
          </h2>
          <p className="text-sm text-zinc-500">
            El pre-filtro descarta el ruido por keywords antes de gastar en la
            clasificación con IA. Editalas acá; aplican desde el próximo poll.
          </p>
        </div>

        <AddKeywordForm />

        {error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            No se pudieron cargar las keywords: {error.message}
          </p>
        ) : keywords.length === 0 ? (
          <p className="rounded-md border border-zinc-200 p-6 text-center text-sm text-zinc-500">
            Todavía no hay keywords cargadas.
          </p>
        ) : (
          <div className="space-y-6">
            {KIND_GROUPS.map((group) => {
              const ofKind = keywords.filter((kw) => kw.kind === group.kind);
              return (
                <div key={group.kind} className="space-y-3">
                  <div className="space-y-0.5">
                    <h3 className="text-sm font-semibold text-zinc-900">
                      {group.title}
                      <span className="ml-2 font-normal text-zinc-400">
                        {ofKind.length}
                      </span>
                    </h3>
                    <p className="text-xs text-zinc-500">
                      {group.description}
                    </p>
                  </div>

                  {ofKind.length === 0 ? (
                    <p className="text-sm text-zinc-400">
                      Sin keywords de {group.title.toLowerCase()}.
                    </p>
                  ) : (
                    LANG_GROUPS.map((langGroup) => {
                      const ofLang = ofKind.filter(
                        (kw) => kw.lang === langGroup.lang,
                      );
                      if (ofLang.length === 0) return null;
                      return (
                        <div key={langGroup.lang} className="space-y-2">
                          <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                            {langGroup.label}
                          </h4>
                          <ul className="space-y-2">
                            {ofLang.map((kw) => (
                              <KeywordRow key={kw.id} keyword={kw} />
                            ))}
                          </ul>
                        </div>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

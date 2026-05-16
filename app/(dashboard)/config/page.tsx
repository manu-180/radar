/**
 * Panel de Configuración: `/config`.
 *
 * Server Component que lee la config manejada por datos del detector. Cubre
 * tres secciones, todas editables desde la web sin tocar código ni redeployar:
 *
 *  1. **Keywords** del pre-filtro (paso 05).
 *  2. **Fuentes**: estado `enabled` y `config` de cada fuente; el `config` se
 *     valida contra el `configSchema` del adaptador antes de guardar.
 *  3. **Ajustes generales** (`settings`): regla de notificación, tope de avisos
 *     por corrida y perfil del freelancer.
 *
 * La página es dinámica: siempre refleja el estado actual de las tablas, y cada
 * server action revalida `/config` para que el cambio se vea al instante.
 */

import { getSource } from "@/lib/sources";
import { getAdminClient } from "@/lib/supabase/admin";

import type { KeywordKind, KeywordLang } from "./actions";
import { AddKeywordForm, type Keyword, KeywordRow } from "./keywords";
import {
  FreelancerProfileForm,
  MaxNotificationsForm,
  NotifyRuleForm,
  type Source,
  SourceRow,
} from "./sources";

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

/** Valores por defecto de `settings`, usados si una clave falta en la tabla. */
const DEFAULT_NOTIFY_RULE = { categories: ["hiring"], minScore: 70 };
const DEFAULT_MAX_NOTIFICATIONS = 10;

export default async function ConfigPage() {
  const db = getAdminClient();
  const [keywordsRes, sourcesRes, settingsRes] = await Promise.all([
    db.from("keywords").select("id, term, kind, lang, enabled").order("term"),
    db.from("sources").select("slug, name, enabled, config").order("id"),
    db
      .from("settings")
      .select("key, value")
      .in("key", [
        "notify_rule",
        "max_notifications_per_run",
        "freelancer_profile",
      ]),
  ]);

  const { data, error } = keywordsRes;
  const keywords = (data ?? []) as Keyword[];

  // Las fuentes salen de la tabla; el registry sólo aporta si hay un adaptador
  // que valide su `config` (telegram/discord aún no tienen uno).
  const sources: Source[] = (sourcesRes.data ?? []).map((row) => ({
    slug: row.slug as string,
    name: row.name as string,
    enabled: row.enabled as boolean,
    hasAdapter: getSource(row.slug as string) !== undefined,
    config: row.config,
  }));

  // Ajustes generales: se indexan por clave y caen al default si faltan.
  const settings = new Map<string, unknown>(
    (settingsRes.data ?? []).map((row) => [row.key as string, row.value]),
  );
  const notifyRule = settings.get("notify_rule") ?? DEFAULT_NOTIFY_RULE;
  const maxRaw = settings.get("max_notifications_per_run");
  const maxNotifications =
    typeof maxRaw === "number" ? maxRaw : DEFAULT_MAX_NOTIFICATIONS;
  const profileRaw = settings.get("freelancer_profile");
  const freelancerProfile = typeof profileRaw === "string" ? profileRaw : "";

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

      {/* --- Sección: fuentes --- */}
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-900">Fuentes</h2>
          <p className="text-sm text-zinc-500">
            Las plataformas que monitorea el detector. Activá o desactivá cada
            una y editá su <code>config</code>; el cambio aplica desde el
            próximo poll. Para la fuente <code>rss</code> los feeds se agregan y
            se quitan desde su <code>config</code>, sin tocar código.
          </p>
        </div>

        {sourcesRes.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            No se pudieron cargar las fuentes: {sourcesRes.error.message}
          </p>
        ) : sources.length === 0 ? (
          <p className="rounded-md border border-zinc-200 p-6 text-center text-sm text-zinc-500">
            Todavía no hay fuentes cargadas.
          </p>
        ) : (
          <ul className="space-y-3">
            {sources.map((source) => (
              // `key` incluye estado y config: tras guardar, la fila remonta
              // con sus valores frescos y el editor refleja lo persistido.
              <SourceRow
                key={`${source.slug}:${source.enabled}:${JSON.stringify(source.config)}`}
                source={source}
              />
            ))}
          </ul>
        )}
      </div>

      {/* --- Sección: ajustes generales --- */}
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-zinc-900">
            Ajustes generales
          </h2>
          <p className="text-sm text-zinc-500">
            Reglas del procesamiento y la notificación. Impactan en la próxima
            corrida.
          </p>
        </div>

        {settingsRes.error ? (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            No se pudieron cargar los ajustes: {settingsRes.error.message}
          </p>
        ) : (
          <div className="space-y-6 rounded-lg border border-zinc-200 p-4">
            <NotifyRuleForm
              key={JSON.stringify(notifyRule)}
              rule={notifyRule}
            />
            <MaxNotificationsForm
              key={maxNotifications}
              value={maxNotifications}
            />
            <FreelancerProfileForm
              key={freelancerProfile}
              profile={freelancerProfile}
            />
          </div>
        )}
      </div>
    </section>
  );
}

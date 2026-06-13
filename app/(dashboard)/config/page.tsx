/**
 * Panel de Configuración: `/config`.
 *
 * Server Component que lee toda la config manejada por datos del sistema y la
 * organiza en pestañas (la activa viaja por `?tab=`, así es server-friendly y
 * compartible):
 *
 *  1. **Autopilot** — el kill-switch maestro de outreach + autopilot por canal,
 *     regla de enganche, topes y política de follow-ups.
 *  2. **Playbook** — el guion del closer (persona, oferta, precios, tono…).
 *  3. **Keywords** del pre-filtro.
 *  4. **Fuentes** — estado y `config` de cada plataforma monitoreada.
 *  5. **Ajustes generales** — regla de notificación, tope de avisos y perfil.
 *
 * La página es dinámica: siempre refleja el estado actual de las tablas, y cada
 * server action revalida `/config` para que el cambio se vea al instante.
 */

import type { Metadata } from "next";
import Link from "next/link";

import {
  DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  DEFAULT_NOTIFY_RULE,
  loadAutopilotSettings,
} from "@/lib/settings";
import { getSource } from "@/lib/sources";
import { getAdminClient } from "@/lib/supabase/admin";

import { PageHeader } from "../ui";
import type { KeywordKind, KeywordLang } from "./actions";
import { AutopilotForm } from "./autopilot-form";
import { AddKeywordForm, type Keyword, KeywordRow } from "./keywords";
import { PlaybookForm } from "./playbook-form";
import {
  FreelancerProfileForm,
  MaxNotificationsForm,
  NotifyRuleForm,
  type Source,
  SourceRow,
} from "./sources";

export const metadata: Metadata = { title: "Configuración" };

/** Render dinámico: la config no se cachea, se lee fresca en cada request. */
export const dynamic = "force-dynamic";

/** Pestañas del panel, en orden. La clave es el valor de `?tab=`. */
const TABS = [
  { key: "autopilot", label: "Autopilot" },
  { key: "playbook", label: "Playbook" },
  { key: "keywords", label: "Keywords" },
  { key: "sources", label: "Fuentes" },
  { key: "general", label: "Ajustes generales" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

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

/** Encabezado de una sección dentro de una pestaña. */
function SectionHead({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <h2 className="text-base font-semibold text-[var(--foreground)]">
        {title}
      </h2>
      <p className="text-sm text-[var(--muted)]">{description}</p>
    </div>
  );
}

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: TabKey = TABS.some((t) => t.key === rawTab)
    ? (rawTab as TabKey)
    : "autopilot";

  const db = getAdminClient();
  const [keywordsRes, sourcesRes, settingsRes, autopilot] = await Promise.all([
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
    loadAutopilotSettings(),
  ]);

  const { data, error } = keywordsRes;
  const keywords = (data ?? []) as Keyword[];

  const sources: Source[] = (sourcesRes.data ?? []).map((row) => ({
    slug: row.slug as string,
    name: row.name as string,
    enabled: row.enabled as boolean,
    hasAdapter: getSource(row.slug as string) !== undefined,
    config: row.config,
  }));

  const settings = new Map<string, unknown>(
    (settingsRes.data ?? []).map((row) => [row.key as string, row.value]),
  );
  const notifyRule = settings.get("notify_rule") ?? DEFAULT_NOTIFY_RULE;
  const maxRaw = settings.get("max_notifications_per_run");
  const maxNotifications =
    typeof maxRaw === "number" ? maxRaw : DEFAULT_MAX_NOTIFICATIONS_PER_RUN;
  const profileRaw = settings.get("freelancer_profile");
  const freelancerProfile = typeof profileRaw === "string" ? profileRaw : "";

  return (
    <section className="space-y-6">
      <PageHeader
        title="Configuración"
        subtitle="Todo lo que el sistema lee en cada corrida. Los cambios impactan sin redeploy."
      />

      {/* Pestañas */}
      <div className="border-b border-[var(--border)]">
        <nav
          className="-mb-px flex flex-wrap gap-1"
          aria-label="Secciones de configuración"
        >
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Link
                key={t.key}
                href={`/config?tab=${t.key}`}
                aria-current={active ? "page" : undefined}
                className={`border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors focus-ring ${
                  active
                    ? "border-[var(--accent)] text-[var(--accent)]"
                    : "border-transparent text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* ===== Pestaña: Autopilot ===== */}
      {tab === "autopilot" && (
        <div className="max-w-3xl space-y-5">
          <SectionHead
            title="Autopilot"
            description="El control del contacto automático. El interruptor de arriba es el kill-switch: con él apagás o encendés todo el outreach al instante."
          />
          <AutopilotForm
            outreachEnabled={autopilot.outreachEnabled}
            channelAutopilot={autopilot.channelAutopilot}
            engageRule={autopilot.engageRule}
            outreachDailyCap={autopilot.outreachDailyCap}
            agentMaxMessages={autopilot.agentMaxMessages}
            followupPolicy={autopilot.followupPolicy}
          />
        </div>
      )}

      {/* ===== Pestaña: Playbook ===== */}
      {tab === "playbook" && (
        <div className="max-w-3xl space-y-5">
          <SectionHead
            title="Playbook del closer"
            description="El guion que define quién es el agente, qué ofrece, a qué precios y cuándo derivarte el lead. Va horneado en cada conversación."
          />
          <PlaybookForm playbook={autopilot.playbook} />
        </div>
      )}

      {/* ===== Pestaña: Keywords ===== */}
      {tab === "keywords" && (
        <div className="max-w-3xl space-y-5">
          <SectionHead
            title="Keywords del pre-filtro"
            description="El pre-filtro descarta el ruido por keywords antes de gastar en la clasificación con IA. Aplican desde el próximo poll."
          />

          <AddKeywordForm />

          {error ? (
            <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger-soft-fg)]">
              No se pudieron cargar las keywords: {error.message}
            </p>
          ) : keywords.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-6 text-center text-sm text-[var(--muted)]">
              Todavía no hay keywords cargadas.
            </p>
          ) : (
            <div className="space-y-6">
              {KIND_GROUPS.map((group) => {
                const ofKind = keywords.filter((kw) => kw.kind === group.kind);
                return (
                  <div key={group.kind} className="space-y-3">
                    <div className="space-y-0.5">
                      <h3 className="text-sm font-semibold text-[var(--foreground)]">
                        {group.title}
                        <span className="ml-2 font-normal text-[var(--subtle)]">
                          {ofKind.length}
                        </span>
                      </h3>
                      <p className="text-xs text-[var(--muted)]">
                        {group.description}
                      </p>
                    </div>

                    {ofKind.length === 0 ? (
                      <p className="text-sm text-[var(--subtle)]">
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
                            <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--subtle)]">
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
      )}

      {/* ===== Pestaña: Fuentes ===== */}
      {tab === "sources" && (
        <div className="max-w-3xl space-y-5">
          <SectionHead
            title="Fuentes"
            description="Las plataformas que monitorea el sistema. Activá o desactivá cada una y editá su config; el cambio aplica desde el próximo poll."
          />

          {sourcesRes.error ? (
            <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger-soft-fg)]">
              No se pudieron cargar las fuentes: {sourcesRes.error.message}
            </p>
          ) : sources.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-6 text-center text-sm text-[var(--muted)]">
              Todavía no hay fuentes cargadas.
            </p>
          ) : (
            <ul className="space-y-3">
              {sources.map((source) => (
                <SourceRow
                  key={`${source.slug}:${source.enabled}:${JSON.stringify(source.config)}`}
                  source={source}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ===== Pestaña: Ajustes generales ===== */}
      {tab === "general" && (
        <div className="max-w-3xl space-y-5">
          <SectionHead
            title="Ajustes generales"
            description="Reglas de la notificación por WhatsApp y el perfil que la IA usa para personalizar. Impactan en la próxima corrida."
          />

          {settingsRes.error ? (
            <p className="rounded-lg border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger-soft-fg)]">
              No se pudieron cargar los ajustes: {settingsRes.error.message}
            </p>
          ) : (
            <div className="space-y-6 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
              <NotifyRuleForm key={JSON.stringify(notifyRule)} rule={notifyRule} />
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
      )}
    </section>
  );
}

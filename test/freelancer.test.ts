import { afterEach, describe, expect, it, vi } from "vitest";

/** Set mínimo de env para que `lib/env` valide (igual que test/prefilter.test.ts). */
const BASE: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ANTHROPIC_API_KEY: "sk-ant-test",
  EVOLUTION_API_URL: "https://evolution.example.com",
  EVOLUTION_API_KEY: "evolution-key",
  EVOLUTION_INSTANCE: "wa-test",
  OWNER_WHATSAPP: "+5491112345678",
  CRON_SECRET: "cron-secret-aleatorio-largo-1234",
  AUTH_SECRET: "auth-secret-aleatorio-largo-1234",
  REDDIT_USER_AGENT: "lead-detector/1.0",
  DASHBOARD_PASSWORD: "dashboard-password",
  APP_URL: "http://localhost:3000",
};

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Carga el adapter con un env válido y, opcionalmente, un token de Freelancer. */
function importFreelancer(extra: Record<string, string> = {}) {
  process.env = { ...BASE, ...extra } as NodeJS.ProcessEnv;
  vi.resetModules();
  return import("../lib/sources/freelancer");
}

describe("freelancerAdapter", () => {
  it("declara skipPrefilter=true (fuente de alta intención)", async () => {
    const { freelancerAdapter } = await importFreelancer();
    expect(freelancerAdapter.skipPrefilter).toBe(true);
  });

  it("sin token queda inerte: devuelve items vacíos sin lanzar", async () => {
    const { freelancerAdapter } = await importFreelancer(); // sin FREELANCER_OAUTH_TOKEN
    const out = await freelancerAdapter.fetchItems({ queries: ["página web"] }, {});
    expect(out.items).toEqual([]);
  });

  it("con token, mapea proyectos a RawItem sin datos de contacto (modelo notify)", async () => {
    const project = {
      id: 123,
      owner_id: 9,
      title: "Necesito una página web para mi pyme",
      description: "Quiero una landing que convierta. Presupuesto a convenir.",
      seo_url: "necesito-pagina-web",
      submitdate: Math.floor(Date.now() / 1000),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "success", result: { projects: [project] } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { freelancerAdapter } = await importFreelancer({
      FREELANCER_OAUTH_TOKEN: "tok-test",
    });
    const out = await freelancerAdapter.fetchItems({ queries: ["página web"] }, {});

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toContain("página web");
    // Freelancer no es contactable dentro de ToS → sin `contact` → cae en notify.
    expect(out.items[0].contact ?? null).toBeNull();
  });
});

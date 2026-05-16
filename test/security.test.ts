import { afterEach, describe, expect, it, vi } from "vitest";

/** Set mínimo de variables REQUERIDAS válidas para que `lib/env` valide. */
const BASE: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ANTHROPIC_API_KEY: "sk-ant-test",
  WASSENGER_API_KEY: "wassenger-key",
  WASSENGER_WEBHOOK_SECRET: "webhook-secret",
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
  vi.resetModules();
});

/** Carga `lib/security` con un `process.env` que satisface a `lib/env`. */
function importSecurity() {
  process.env = { ...BASE } as NodeJS.ProcessEnv;
  vi.resetModules();
  return import("../lib/security");
}

describe("timingSafeEqualStr", () => {
  it("devuelve true para strings idénticos", async () => {
    const { timingSafeEqualStr } = await importSecurity();
    expect(timingSafeEqualStr("secreto-abc-123", "secreto-abc-123")).toBe(true);
  });

  it("devuelve false para strings distintos del mismo largo", async () => {
    const { timingSafeEqualStr } = await importSecurity();
    expect(timingSafeEqualStr("secreto-abc-123", "secreto-xyz-123")).toBe(false);
  });

  it("devuelve false para strings de distinto largo sin lanzar", async () => {
    const { timingSafeEqualStr } = await importSecurity();
    expect(timingSafeEqualStr("corto", "mucho-mas-largo")).toBe(false);
  });

  it("devuelve true para dos strings vacíos", async () => {
    const { timingSafeEqualStr } = await importSecurity();
    expect(timingSafeEqualStr("", "")).toBe(true);
  });
});

describe("verifyCronSecret", () => {
  it("acepta el request con el header x-cron-secret correcto", async () => {
    const { verifyCronSecret } = await importSecurity();
    const request = new Request("https://app.test/api/cron", {
      headers: { "x-cron-secret": BASE.CRON_SECRET },
    });
    expect(verifyCronSecret(request)).toBe(true);
  });

  it("rechaza el request sin header o con un secreto incorrecto", async () => {
    const { verifyCronSecret } = await importSecurity();
    expect(
      verifyCronSecret(new Request("https://app.test/api/cron")),
    ).toBe(false);
    expect(
      verifyCronSecret(
        new Request("https://app.test/api/cron", {
          headers: { "x-cron-secret": "secreto-equivocado" },
        }),
      ),
    ).toBe(false);
  });
});

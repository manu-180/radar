import { afterEach, describe, expect, it, vi } from "vitest";

/** Set mínimo de variables REQUERIDAS válidas. */
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
  vi.resetModules();
});

/** Carga `lib/env` con un `process.env` controlado. */
function importEnv(values: Record<string, string | undefined>) {
  process.env = { ...values } as NodeJS.ProcessEnv;
  vi.resetModules();
  return import("../lib/env");
}

/** Copia de `BASE` sin las claves indicadas. */
function baseWithout(...keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...BASE };
  for (const key of keys) delete out[key];
  return out;
}

describe("lib/env", () => {
  it("valida y expone un env tipado con las requeridas presentes", async () => {
    const { env } = await importEnv(BASE);
    expect(env.NEXT_PUBLIC.SUPABASE_URL).toBe(BASE.NEXT_PUBLIC_SUPABASE_URL);
    expect(env.NEXT_PUBLIC.SUPABASE_ANON_KEY).toBe(
      BASE.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
    expect(env.OWNER_WHATSAPP).toBe(BASE.OWNER_WHATSAPP);
    expect(env.APP_URL).toBe("http://localhost:3000");
  });

  it("lanza un error que nombra la variable requerida faltante", async () => {
    await expect(importEnv(baseWithout("ANTHROPIC_API_KEY"))).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("trata una variable requerida vacía como faltante", async () => {
    await expect(
      importEnv({ ...BASE, EVOLUTION_API_KEY: "" }),
    ).rejects.toThrow(/EVOLUTION_API_KEY/);
  });

  it("rechaza un EVOLUTION_API_URL que no sea una URL válida", async () => {
    await expect(
      importEnv({ ...BASE, EVOLUTION_API_URL: "no-es-una-url" }),
    ).rejects.toThrow(/EVOLUTION_API_URL/);
  });

  it("rechaza un OWNER_WHATSAPP que no esté en formato E.164", async () => {
    await expect(
      importEnv({ ...BASE, OWNER_WHATSAPP: "1112345678" }),
    ).rejects.toThrow(/OWNER_WHATSAPP/);
  });

  it("arranca sin error aunque falten las variables opcionales", async () => {
    const { env } = await importEnv(BASE);
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.SCRAPER_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_SESSION).toBeUndefined();
  });

  it("deriva APP_URL desde VERCEL_URL cuando APP_URL no está seteada", async () => {
    const withVercel = {
      ...baseWithout("APP_URL"),
      VERCEL_URL: "mi-deploy.vercel.app",
    };
    const { env } = await importEnv(withVercel);
    expect(env.APP_URL).toBe("https://mi-deploy.vercel.app");
  });

  it("falla si no hay ni APP_URL ni VERCEL_URL", async () => {
    await expect(importEnv(baseWithout("APP_URL"))).rejects.toThrow(/APP_URL/);
  });
});

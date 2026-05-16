import { afterEach, describe, expect, it, vi } from "vitest";

import type { Keyword } from "../lib/filter/prefilter";
import type { RawItem } from "../lib/sources/types";

/**
 * Set mínimo de variables REQUERIDAS válidas para que `lib/env` valide.
 *
 * `lib/filter/prefilter` importa `lib/supabase/admin`, que a su vez importa
 * `lib/env` — y `lib/env` valida `process.env` al evaluarse. Por eso el módulo
 * se importa de forma dinámica recién después de sembrar el entorno.
 */
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

/** Carga `lib/filter/prefilter` con un `process.env` que satisface a `lib/env`. */
function importPrefilter() {
  process.env = { ...BASE } as NodeJS.ProcessEnv;
  vi.resetModules();
  return import("../lib/filter/prefilter");
}

/** Keywords de prueba, una muestra representativa de la tabla `keywords`. */
const KEYWORDS: Keyword[] = [
  { term: "necesito un desarrollador", kind: "include", lang: "es" },
  { term: "desarrollador web", kind: "include", lang: "es" },
  { term: "need a developer", kind: "include", lang: "en" },
  { term: "looking to hire", kind: "include", lang: "en" },
  { term: "busco trabajo", kind: "exclude", lang: "es" },
  { term: "looking for work", kind: "exclude", lang: "en" },
  { term: "spam", kind: "exclude", lang: "any" },
];

/** Construye un `RawItem` mínimo, sobreescribiendo solo los campos del test. */
function makeItem(overrides: Partial<RawItem>): RawItem {
  return {
    externalId: null,
    title: "",
    body: "",
    url: "",
    author: null,
    postedAt: null,
    raw: null,
    ...overrides,
  };
}

describe("prefilter", () => {
  it("deja pasar un pedido de contratación en español", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "Necesito un desarrollador para mi proyecto" }),
      "es",
      KEYWORDS,
    );
    expect(result.passed).toBe(true);
    expect(result.matched).toContain("necesito un desarrollador");
    expect(result.reason).toMatch(/inclusi/i);
  });

  it("deja pasar un pedido de contratación en inglés", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "Need a developer for a small website" }),
      "en",
      KEYWORDS,
    );
    expect(result.passed).toBe(true);
    expect(result.matched).toContain("need a developer");
  });

  it("rechaza a quien busca trabajo en español aunque mencione el rubro", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "Busco trabajo como desarrollador web" }),
      "es",
      KEYWORDS,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toContain("busco trabajo");
    expect(result.reason).toMatch(/excluido/i);
  });

  it("rechaza a quien busca trabajo en inglés", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "Senior developer looking for work, remote only" }),
      "en",
      KEYWORDS,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toContain("looking for work");
  });

  it("la exclusión gana sobre la inclusión en el mismo texto", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({
        title: "Necesito un desarrollador",
        body: "pero busco trabajo yo también",
      }),
      "es",
      KEYWORDS,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toContain("busco trabajo");
  });

  it("ignora el casing y los acentos al matchear", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "NECESITO UN DESARROLLADOR" }),
      "es",
      KEYWORDS,
    );
    expect(result.passed).toBe(true);
  });

  it("no aplica keywords de otro idioma", async () => {
    const { prefilter } = await importPrefilter();
    // El texto contiene una keyword `include` de español, pero el item es 'en':
    // esa keyword no aplica, así que no hay match de inclusión.
    const result = prefilter(
      makeItem({ title: "necesito un desarrollador" }),
      "en",
      KEYWORDS,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toEqual([]);
  });

  it("aplica las keywords `any` en cualquier idioma", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "this is spam, need a developer" }),
      "en",
      KEYWORDS,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toContain("spam");
  });

  it("no pasa cuando no coincide ninguna keyword de inclusión", async () => {
    const { prefilter } = await importPrefilter();
    const result = prefilter(
      makeItem({ title: "Vendo bicicleta usada en buen estado" }),
      "es",
      KEYWORDS,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toEqual([]);
    expect(result.reason).toMatch(/ninguna keyword de inclusi/i);
  });
});

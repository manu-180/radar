import { describe, expect, it, vi } from "vitest";

/**
 * Tests de `buildAgentSystemPrompt` (`lib/ai/agent`).
 *
 * La función es pura: toma un `AgentPlaybook` y devuelve un string. No llama a
 * la red ni a la DB. El único obstáculo para importarla es que `lib/ai/agent`
 * importa `lib/env`, que valida `process.env` al cargarse y lanzaría en el
 * entorno de tests (sin variables reales). Se resuelve mockeando `lib/env`
 * antes del import dinámico, igual que `lib/supabase/admin` se mockea en
 * `settings.test.ts`.
 */

// Mock de lib/env: evita que la validación de Zod se ejecute al importar.
// Solo se expone ANTHROPIC_API_KEY porque es la única que usa lib/ai/agent
// (y solo dentro de getClient(), que no se llama en estos tests).
vi.mock("@/lib/env", () => ({
  env: {
    ANTHROPIC_API_KEY: "sk-ant-test-key",
    NEXT_PUBLIC: {
      SUPABASE_URL: "https://test.supabase.co",
      SUPABASE_ANON_KEY: "anon-key-test",
    },
  },
}));

const { buildAgentSystemPrompt, DEFAULT_AGENT_MODEL } = await import(
  "../lib/ai/agent"
);

/** Playbook mínimo válido para los tests. */
const TEST_PLAYBOOK = {
  persona: "Soy un dev freelance argentino.",
  offer: "Hago webs y apps con Next.js y Supabase.",
  pricing: "USD 150–300 landing, USD 300–700 sitio completo.",
  tone: "Directo, cálido, sin vueltas.",
  goal: "Que el cliente pida una propuesta o un boceto.",
  handoff_triggers:
    "Pide boceto, presupuesto formal, quiere hablar con una persona.",
} as const;

describe("buildAgentSystemPrompt", () => {
  it("incluye el campo `persona` del playbook", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain(TEST_PLAYBOOK.persona);
  });

  it("incluye el campo `offer` del playbook", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain(TEST_PLAYBOOK.offer);
  });

  it("incluye el campo `pricing` del playbook", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain(TEST_PLAYBOOK.pricing);
  });

  it("incluye el campo `tone` del playbook", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain(TEST_PLAYBOOK.tone);
  });

  it("incluye el campo `goal` del playbook", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain(TEST_PLAYBOOK.goal);
  });

  it("incluye los `handoff_triggers` del playbook", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain(TEST_PLAYBOOK.handoff_triggers);
  });

  it("incluye la sección de HANDOFF con instrucciones al agente", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain("HANDOFF");
  });

  it("incluye la instrucción de llamar a la tool `respond`", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    expect(prompt).toContain("respond");
  });

  it("incluye la sección de seguridad (anti prompt-injection)", () => {
    const prompt = buildAgentSystemPrompt(TEST_PLAYBOOK);
    // La sección de seguridad advierte que los mensajes del lead son DATO.
    expect(prompt).toMatch(/DATO|instrucciones|seguridad/i);
  });

  it("devuelve un string distinto para playbooks distintos", () => {
    const other = {
      ...TEST_PLAYBOOK,
      persona: "Soy un dev de Córdoba especialista en e-commerce.",
      pricing: "USD 500–2000 para tiendas online.",
    };
    const p1 = buildAgentSystemPrompt(TEST_PLAYBOOK);
    const p2 = buildAgentSystemPrompt(other);
    expect(p1).not.toBe(p2);
    expect(p2).toContain(other.persona);
    expect(p2).toContain(other.pricing);
  });

  it("es determinista: el mismo playbook siempre produce el mismo prompt", () => {
    expect(buildAgentSystemPrompt(TEST_PLAYBOOK)).toBe(
      buildAgentSystemPrompt(TEST_PLAYBOOK),
    );
  });

  it("el prompt tiene una longitud razonable (más de 500 caracteres)", () => {
    // Verifica que el prompt no está vacío ni truncado de forma inesperada.
    expect(buildAgentSystemPrompt(TEST_PLAYBOOK).length).toBeGreaterThan(500);
  });
});

describe("DEFAULT_AGENT_MODEL", () => {
  it("está definido y es un string no vacío", () => {
    expect(typeof DEFAULT_AGENT_MODEL).toBe("string");
    expect(DEFAULT_AGENT_MODEL.length).toBeGreaterThan(0);
  });
});

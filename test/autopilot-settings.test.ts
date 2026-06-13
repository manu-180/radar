import { describe, expect, it, vi } from "vitest";

/**
 * Tests de los parsers puros de la capa Autopilot (v2) de `lib/settings`.
 *
 * Sólo se importan las funciones y constantes exportadas que son **puras**
 * (no leen la DB): `parsePlaybook`, `parseChannelAutopilot`,
 * `parseFollowupPolicy` y sus DEFAULT_* correspondientes.
 *
 * El módulo usa `server-only` y `getAdminClient`; mockeamos el cliente de la
 * misma forma que `settings.test.ts` para evitar cargar `lib/env` durante
 * la importación.
 */

// Mismo mock de admin que el resto de tests de settings: evita cargar lib/env.
vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  }),
}));

const {
  parsePlaybook,
  parseChannelAutopilot,
  parseFollowupPolicy,
  DEFAULT_PLAYBOOK,
  DEFAULT_CHANNEL_AUTOPILOT,
  DEFAULT_FOLLOWUP_POLICY,
} = await import("../lib/settings");

// ─── parsePlaybook ────────────────────────────────────────────────────────────

describe("parsePlaybook", () => {
  it("devuelve el DEFAULT_PLAYBOOK cuando el input es undefined", () => {
    expect(parsePlaybook(undefined)).toEqual(DEFAULT_PLAYBOOK);
  });

  it("devuelve el DEFAULT_PLAYBOOK cuando el input es null", () => {
    expect(parsePlaybook(null)).toEqual(DEFAULT_PLAYBOOK);
  });

  it("devuelve el DEFAULT_PLAYBOOK cuando el input es inválido (string)", () => {
    expect(parsePlaybook("texto suelto")).toEqual(DEFAULT_PLAYBOOK);
  });

  it("devuelve el DEFAULT_PLAYBOOK cuando el input es un objeto vacío", () => {
    // Un objeto vacío pasa la validación partial() de Zod (todos opcionales),
    // pero al hacer spread sobre el default, el resultado es igual al default.
    expect(parsePlaybook({})).toEqual(DEFAULT_PLAYBOOK);
  });

  it("mezcla un campo provisto sobre el default (parcial válido)", () => {
    const result = parsePlaybook({ persona: "Soy un dev freelance porteño." });
    expect(result.persona).toBe("Soy un dev freelance porteño.");
    // El resto de los campos heredan del default.
    expect(result.offer).toBe(DEFAULT_PLAYBOOK.offer);
    expect(result.pricing).toBe(DEFAULT_PLAYBOOK.pricing);
    expect(result.tone).toBe(DEFAULT_PLAYBOOK.tone);
    expect(result.goal).toBe(DEFAULT_PLAYBOOK.goal);
    expect(result.handoff_triggers).toBe(DEFAULT_PLAYBOOK.handoff_triggers);
  });

  it("mezcla múltiples campos provistos sobre el default", () => {
    const partial = {
      persona: "Dev Node.js, 5 años de experiencia.",
      offer: "Apps web y mobile con Next.js y React Native.",
      pricing: "USD 200–500 para landing, cotizo el resto.",
    };
    const result = parsePlaybook(partial);
    expect(result.persona).toBe(partial.persona);
    expect(result.offer).toBe(partial.offer);
    expect(result.pricing).toBe(partial.pricing);
    // Campos no provistos siguen siendo los del default.
    expect(result.tone).toBe(DEFAULT_PLAYBOOK.tone);
    expect(result.goal).toBe(DEFAULT_PLAYBOOK.goal);
  });

  it("rechaza un campo con string vacío (min(1)) y vuelve al default", () => {
    // Una persona vacía falla la validación min(1); Zod rechaza el objeto completo.
    const result = parsePlaybook({ persona: "" });
    expect(result).toEqual(DEFAULT_PLAYBOOK);
  });

  it("devuelve un playbook completo si todos los campos son válidos", () => {
    const full = {
      persona: "Dev web argentino.",
      offer: "Webs y apps.",
      pricing: "USD 150–700.",
      tone: "Directo y cálido.",
      goal: "Conseguir un boceto.",
      handoff_triggers: "Pide propuesta o boceto.",
    };
    expect(parsePlaybook(full)).toEqual(full);
  });
});

// ─── parseChannelAutopilot ────────────────────────────────────────────────────

describe("parseChannelAutopilot", () => {
  it("devuelve el DEFAULT_CHANNEL_AUTOPILOT cuando el input es undefined", () => {
    expect(parseChannelAutopilot(undefined)).toEqual(DEFAULT_CHANNEL_AUTOPILOT);
  });

  it("devuelve el DEFAULT_CHANNEL_AUTOPILOT cuando el input es null", () => {
    expect(parseChannelAutopilot(null)).toEqual(DEFAULT_CHANNEL_AUTOPILOT);
  });

  it("devuelve el DEFAULT_CHANNEL_AUTOPILOT cuando el input es inválido", () => {
    expect(parseChannelAutopilot("no-es-objeto")).toEqual(
      DEFAULT_CHANNEL_AUTOPILOT,
    );
  });

  it("rellena canales faltantes con los defaults cuando el input es parcial válido", () => {
    // Solo se provee `telegram`; el resto se rellena con el default.
    const result = parseChannelAutopilot({ telegram: false });
    expect(result.telegram).toBe(false);
    expect(result.bluesky).toBe(DEFAULT_CHANNEL_AUTOPILOT.bluesky);
    expect(result.whatsapp).toBe(DEFAULT_CHANNEL_AUTOPILOT.whatsapp);
    expect(result.reddit).toBe(DEFAULT_CHANNEL_AUTOPILOT.reddit);
  });

  it("respeta los booleanos provistos para todos los canales", () => {
    const input = { telegram: false, bluesky: false, whatsapp: false, reddit: true };
    const result = parseChannelAutopilot(input);
    expect(result).toEqual(input);
  });

  it("reddit está en false en el DEFAULT_CHANNEL_AUTOPILOT (canal gated)", () => {
    // Verifica que el default sea seguro (reddit off por defecto).
    expect(DEFAULT_CHANNEL_AUTOPILOT.reddit).toBe(false);
  });

  it("telegram, bluesky y whatsapp están en true en el DEFAULT_CHANNEL_AUTOPILOT", () => {
    expect(DEFAULT_CHANNEL_AUTOPILOT.telegram).toBe(true);
    expect(DEFAULT_CHANNEL_AUTOPILOT.bluesky).toBe(true);
    expect(DEFAULT_CHANNEL_AUTOPILOT.whatsapp).toBe(true);
  });
});

// ─── parseFollowupPolicy ──────────────────────────────────────────────────────

describe("parseFollowupPolicy", () => {
  it("devuelve el DEFAULT_FOLLOWUP_POLICY cuando el input es undefined", () => {
    expect(parseFollowupPolicy(undefined)).toEqual(DEFAULT_FOLLOWUP_POLICY);
  });

  it("devuelve el DEFAULT_FOLLOWUP_POLICY cuando el input es null", () => {
    expect(parseFollowupPolicy(null)).toEqual(DEFAULT_FOLLOWUP_POLICY);
  });

  it("devuelve el DEFAULT_FOLLOWUP_POLICY cuando el input es inválido", () => {
    expect(parseFollowupPolicy({ delaysHours: [], maxFollowups: 2 })).toEqual(
      DEFAULT_FOLLOWUP_POLICY,
    );
    // delaysHours must have min(1) entries.
  });

  it("devuelve el DEFAULT_FOLLOWUP_POLICY cuando maxFollowups es negativo", () => {
    expect(
      parseFollowupPolicy({ delaysHours: [24], maxFollowups: -1 }),
    ).toEqual(DEFAULT_FOLLOWUP_POLICY);
  });

  it("acepta una política válida con un solo delay", () => {
    const policy = { delaysHours: [48], maxFollowups: 1 };
    expect(parseFollowupPolicy(policy)).toEqual(policy);
  });

  it("acepta una política válida con múltiples delays", () => {
    const policy = { delaysHours: [24, 72, 168], maxFollowups: 3 };
    expect(parseFollowupPolicy(policy)).toEqual(policy);
  });

  it("acepta maxFollowups = 0 (deshabilita los follow-ups)", () => {
    const policy = { delaysHours: [24], maxFollowups: 0 };
    expect(parseFollowupPolicy(policy)).toEqual(policy);
  });

  it("verifica que el DEFAULT_FOLLOWUP_POLICY tiene valores sensatos", () => {
    expect(DEFAULT_FOLLOWUP_POLICY.delaysHours).toEqual([24, 72]);
    expect(DEFAULT_FOLLOWUP_POLICY.maxFollowups).toBe(2);
  });
});

import { describe, expect, it } from "vitest";

import {
  addUsage,
  costUsd,
  emptyUsage,
  MODEL_PRICING,
  roundCost,
  totalInputTokens,
  type TokenUsage,
} from "../lib/ai/pricing";

/** Construye un `TokenUsage` dejando en 0 los baldes no especificados. */
function usage(overrides: Partial<TokenUsage>): TokenUsage {
  return { ...emptyUsage(), ...overrides };
}

describe("emptyUsage / addUsage / totalInputTokens", () => {
  it("emptyUsage arranca todos los baldes en cero", () => {
    expect(emptyUsage()).toEqual({
      uncachedInputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
  });

  it("addUsage suma balde a balde sin mutar los argumentos", () => {
    const a = usage({ uncachedInputTokens: 10, outputTokens: 1 });
    const b = usage({
      uncachedInputTokens: 5,
      cacheReadTokens: 7,
      outputTokens: 2,
    });
    expect(addUsage(a, b)).toEqual({
      uncachedInputTokens: 15,
      cacheCreationTokens: 0,
      cacheReadTokens: 7,
      outputTokens: 3,
    });
    // Los argumentos quedan intactos.
    expect(a.uncachedInputTokens).toBe(10);
    expect(b.cacheReadTokens).toBe(7);
  });

  it("totalInputTokens suma los tres baldes de entrada", () => {
    expect(
      totalInputTokens(
        usage({
          uncachedInputTokens: 100,
          cacheCreationTokens: 20,
          cacheReadTokens: 3,
          outputTokens: 999,
        }),
      ),
    ).toBe(123);
  });
});

describe("costUsd", () => {
  it("cobra los tokens de entrada sin caché a la tarifa base del modelo", () => {
    expect(
      costUsd("claude-haiku-4-5", usage({ uncachedInputTokens: 1_000_000 })),
    ).toBeCloseTo(1, 6);
  });

  it("cobra la escritura de caché a 1.25x la tarifa de entrada", () => {
    expect(
      costUsd("claude-haiku-4-5", usage({ cacheCreationTokens: 1_000_000 })),
    ).toBeCloseTo(1.25, 6);
  });

  it("cobra la lectura de caché a 0.10x la tarifa de entrada", () => {
    expect(
      costUsd("claude-haiku-4-5", usage({ cacheReadTokens: 1_000_000 })),
    ).toBeCloseTo(0.1, 6);
  });

  it("cobra los tokens de salida a la tarifa de salida", () => {
    expect(
      costUsd("claude-haiku-4-5", usage({ outputTokens: 1_000_000 })),
    ).toBeCloseTo(5, 6);
  });

  it("suma los cuatro baldes, cada uno con su tarifa", () => {
    const u = usage({
      uncachedInputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1 (in) + 1.25 (cache write) + 0.10 (cache read) + 5 (out)
    expect(costUsd("claude-haiku-4-5", u)).toBeCloseTo(7.35, 6);
  });

  it("usa la tarifa propia de cada modelo", () => {
    expect(
      costUsd("claude-sonnet-4-6", usage({ uncachedInputTokens: 1_000_000 })),
    ).toBeCloseTo(3, 6);
  });

  it("un modelo desconocido cuesta 0 en vez de lanzar", () => {
    expect(
      costUsd("modelo-inexistente", usage({ uncachedInputTokens: 1e9 })),
    ).toBe(0);
  });

  it("un uso vacío cuesta 0", () => {
    expect(costUsd("claude-haiku-4-5", emptyUsage())).toBe(0);
  });
});

describe("roundCost", () => {
  it("redondea a 6 decimales (la precisión de llm_cost_usd)", () => {
    expect(roundCost(0.123456789)).toBe(0.123457);
  });

  it("deja intacto un valor que ya cabe en 6 decimales", () => {
    expect(roundCost(1.5)).toBe(1.5);
    expect(roundCost(0)).toBe(0);
  });
});

describe("MODEL_PRICING", () => {
  it("tiene tarifa para los dos modelos del clasificador", () => {
    expect(MODEL_PRICING["claude-haiku-4-5"]).toEqual({ input: 1, output: 5 });
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toEqual({ input: 3, output: 15 });
  });
});

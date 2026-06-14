import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests del cargador de settings (`lib/settings`).
 *
 * `lib/settings` lee la tabla `settings` a través de `getAdminClient`. Se
 * mockea ese módulo con un cliente falso en memoria que sólo soporta la cadena
 * `from("settings").select(...).in(...)`. Mockearlo tiene, además, el efecto
 * colateral de no cargar `lib/env`, así que el test no necesita sembrar el
 * entorno (mismo patrón que `leads-dedup.test.ts`).
 */

/** Fila de la tabla `settings`. */
type SettingRow = { key: string; value: unknown };

/** Cliente Supabase falso: soporta sólo `from("settings").select(...).in(...)`. */
function fakeClient(rows: SettingRow[] | { error: string }) {
  return {
    from() {
      return {
        select() {
          return {
            in(_col: string, keys: string[]) {
              if (!Array.isArray(rows)) {
                return Promise.resolve({
                  data: null,
                  error: { message: rows.error },
                });
              }
              return Promise.resolve({
                data: rows.filter((r) => keys.includes(r.key)),
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => hoisted.client,
}));

const {
  loadProcessSettings,
  loadNotifySettings,
  loadClassifierBudget,
  notifyRuleSchema,
  DEFAULT_NOTIFY_RULE,
  DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
  DEFAULT_FEEDBACK_EXAMPLES_COUNT,
  DEFAULT_CLASSIFIER_BUDGET_USD,
} = await import("../lib/settings");

/** Apunta el cliente mockeado a un set de filas de `settings` (o a un error). */
function withSettings(rows: SettingRow[] | { error: string }): void {
  hoisted.client = fakeClient(rows);
}

beforeEach(() => {
  withSettings([]);
});

describe("notifyRuleSchema", () => {
  it("acepta una regla válida", () => {
    expect(
      notifyRuleSchema.safeParse({ categories: ["hiring"], minScore: 70 })
        .success,
    ).toBe(true);
  });

  it("rechaza una lista de categorías vacía", () => {
    expect(
      notifyRuleSchema.safeParse({ categories: [], minScore: 70 }).success,
    ).toBe(false);
  });

  it("rechaza una categoría desconocida", () => {
    expect(
      notifyRuleSchema.safeParse({ categories: ["spam"], minScore: 70 }).success,
    ).toBe(false);
  });

  it("rechaza un minScore fuera de 0–100 o no entero", () => {
    expect(
      notifyRuleSchema.safeParse({ categories: ["hiring"], minScore: 150 })
        .success,
    ).toBe(false);
    expect(
      notifyRuleSchema.safeParse({ categories: ["hiring"], minScore: 70.5 })
        .success,
    ).toBe(false);
  });
});

describe("loadProcessSettings", () => {
  it("devuelve los valores guardados cuando están presentes y son válidos", async () => {
    withSettings([
      { key: "freelancer_profile", value: "Mi perfil" },
      {
        key: "notify_rule",
        value: { categories: ["hiring", "maybe"], minScore: 50 },
      },
      { key: "feedback_examples_count", value: 4 },
    ]);

    expect(await loadProcessSettings()).toEqual({
      freelancerProfile: "Mi perfil",
      notifyRule: { categories: ["hiring", "maybe"], minScore: 50 },
      feedbackExamplesCount: 4,
    });
  });

  it("cae a los defaults cuando las claves faltan", async () => {
    const s = await loadProcessSettings();
    expect(s.freelancerProfile).toBe("");
    expect(s.notifyRule).toEqual(DEFAULT_NOTIFY_RULE);
    expect(s.feedbackExamplesCount).toBe(DEFAULT_FEEDBACK_EXAMPLES_COUNT);
  });

  it("cae al default de notify_rule cuando el valor guardado es inválido", async () => {
    withSettings([
      { key: "notify_rule", value: { categories: [], minScore: 999 } },
    ]);
    expect((await loadProcessSettings()).notifyRule).toEqual(
      DEFAULT_NOTIFY_RULE,
    );
  });

  it("acepta feedback_examples_count = 0 (desactiva los ejemplos)", async () => {
    withSettings([{ key: "feedback_examples_count", value: 0 }]);
    expect((await loadProcessSettings()).feedbackExamplesCount).toBe(0);
  });

  it("ignora un feedback_examples_count negativo o no numérico", async () => {
    withSettings([{ key: "feedback_examples_count", value: -3 }]);
    expect((await loadProcessSettings()).feedbackExamplesCount).toBe(
      DEFAULT_FEEDBACK_EXAMPLES_COUNT,
    );
  });

  it("lanza si la consulta a settings falla", async () => {
    withSettings({ error: "conexión caída" });
    await expect(loadProcessSettings()).rejects.toThrow(/conexión caída/);
  });
});

describe("loadNotifySettings", () => {
  it("devuelve los valores guardados", async () => {
    withSettings([
      { key: "notify_rule", value: { categories: ["hiring"], minScore: 80 } },
      { key: "max_notifications_per_run", value: 25 },
    ]);
    expect(await loadNotifySettings()).toEqual({
      notifyRule: { categories: ["hiring"], minScore: 80 },
      maxNotificationsPerRun: 25,
    });
  });

  it("cae a los defaults cuando las claves faltan", async () => {
    const s = await loadNotifySettings();
    expect(s.notifyRule).toEqual(DEFAULT_NOTIFY_RULE);
    expect(s.maxNotificationsPerRun).toBe(DEFAULT_MAX_NOTIFICATIONS_PER_RUN);
  });

  it("trunca un max_notifications_per_run flotante", async () => {
    withSettings([{ key: "max_notifications_per_run", value: 7.9 }]);
    expect((await loadNotifySettings()).maxNotificationsPerRun).toBe(7);
  });

  it("ignora un max_notifications_per_run no positivo", async () => {
    withSettings([{ key: "max_notifications_per_run", value: 0 }]);
    expect((await loadNotifySettings()).maxNotificationsPerRun).toBe(
      DEFAULT_MAX_NOTIFICATIONS_PER_RUN,
    );
  });
});

describe("loadClassifierBudget", () => {
  it("sin la clave, usa el tope por defecto (cap seguro, NO ilimitado)", async () => {
    const budget = await loadClassifierBudget();
    expect(budget.budgetUsd).toBe(DEFAULT_CLASSIFIER_BUDGET_USD);
    expect(budget.paused).toBe(false);
    expect(budget.spendBaselineUsd).toBe(0);
  });

  it("respeta un tope explícito", async () => {
    withSettings([{ key: "classifier_budget_usd", value: 12 }]);
    expect((await loadClassifierBudget()).budgetUsd).toBe(12);
  });

  it("trata 0 como ilimitado (opt-out explícito)", async () => {
    withSettings([{ key: "classifier_budget_usd", value: 0 }]);
    expect((await loadClassifierBudget()).budgetUsd).toBeNull();
  });

  it("trata un negativo como ilimitado", async () => {
    withSettings([{ key: "classifier_budget_usd", value: -5 }]);
    expect((await loadClassifierBudget()).budgetUsd).toBeNull();
  });

  it("un tope no numérico cae al default", async () => {
    withSettings([{ key: "classifier_budget_usd", value: "muchos" }]);
    expect((await loadClassifierBudget()).budgetUsd).toBe(
      DEFAULT_CLASSIFIER_BUDGET_USD,
    );
  });

  it("lee el flag de pausa", async () => {
    withSettings([{ key: "classifier_paused", value: true }]);
    expect((await loadClassifierBudget()).paused).toBe(true);
  });

  it("lee el baseline de gasto y cae a 0 si es inválido", async () => {
    withSettings([{ key: "classifier_spend_baseline_usd", value: 3.5 }]);
    expect((await loadClassifierBudget()).spendBaselineUsd).toBe(3.5);
    withSettings([{ key: "classifier_spend_baseline_usd", value: "x" }]);
    expect((await loadClassifierBudget()).spendBaselineUsd).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LeadRow } from "../lib/db/leads";

/**
 * Tests de los helpers de base de datos del paso 11.
 *
 * `lib/db/leads` y `lib/db/runs` hablan con Supabase a través de
 * `getAdminClient`. Para probarlos sin una base real se mockea ese módulo con
 * un cliente Supabase falso en memoria que **respeta los dos índices únicos**
 * del esquema (`content_hash` y `(source, external_id)`): así la deduplicación,
 * que en producción la garantiza la base, se ejerce de verdad en el test.
 *
 * Mockear `lib/supabase/admin` tiene un efecto colateral útil: el módulo real
 * importa `lib/env`, que valida `process.env` al evaluarse. Al reemplazarlo,
 * los tests no necesitan sembrar variables de entorno.
 */

// ===== Cliente Supabase falso en memoria =====

type Row = Record<string, unknown>;

interface Store {
  leads: Row[];
  runs: Row[];
  nextId: number;
}

interface DbResult {
  data: unknown;
  error: { message: string } | null;
}

type Filter =
  | { kind: "in"; col: string; vals: unknown[] }
  | { kind: "eq"; col: string; val: unknown };

/**
 * Query builder falso: imita el encadenamiento de `@supabase/supabase-js`
 * (`select`/`insert`/`update`/`upsert` + `in`/`eq`/`single`) y es awaitable.
 */
class FakeQuery implements PromiseLike<DbResult> {
  private op: "select" | "insert" | "update" | "upsert" = "select";
  private values: Row[] = [];
  private patch: Row = {};
  private filters: Filter[] = [];
  private returning = false;
  private wantSingle = false;
  private ignoreDuplicates = false;

  constructor(
    private readonly store: Store,
    private readonly table: "leads" | "runs",
  ) {}

  select(): this {
    this.returning = true;
    return this;
  }

  insert(values: Row | Row[]): this {
    this.op = "insert";
    this.values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }

  upsert(values: Row | Row[], opts?: { ignoreDuplicates?: boolean }): this {
    this.op = "upsert";
    this.values = Array.isArray(values) ? values : [values];
    this.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ kind: "in", col, vals });
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }

  single(): this {
    this.wantSingle = true;
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) =>
      f.kind === "in" ? f.vals.includes(row[f.col]) : row[f.col] === f.val,
    );
  }

  /** Replica las dos restricciones únicas de la tabla `leads`. */
  private conflicts(row: Row): boolean {
    return this.store[this.table].some(
      (r) =>
        r.content_hash === row.content_hash ||
        (row.external_id != null &&
          r.external_id != null &&
          r.source === row.source &&
          r.external_id === row.external_id),
    );
  }

  private run(): DbResult {
    const rows = this.store[this.table];

    if (this.op === "select") {
      const found = rows.filter((r) => this.matches(r)).map((r) => ({ ...r }));
      return { data: this.wantSingle ? (found[0] ?? null) : found, error: null };
    }

    if (this.op === "insert") {
      const inserted = this.values.map((v) => {
        const row: Row = { ...v, id: this.store.nextId++ };
        rows.push(row);
        return { ...row };
      });
      return {
        data: this.returning
          ? this.wantSingle
            ? (inserted[0] ?? null)
            : inserted
          : null,
        error: null,
      };
    }

    if (this.op === "update") {
      for (const r of rows.filter((r) => this.matches(r))) {
        Object.assign(r, this.patch);
      }
      return { data: null, error: null };
    }

    // upsert con `ON CONFLICT DO NOTHING`: los choques se ignoran y no se
    // devuelven, así `data.length` cuenta solo lo realmente insertado.
    const inserted: Row[] = [];
    for (const v of this.values) {
      if (this.conflicts(v)) {
        if (this.ignoreDuplicates) continue;
        return { data: null, error: { message: "duplicate key value" } };
      }
      const row: Row = { ...v, id: this.store.nextId++ };
      rows.push(row);
      inserted.push({ ...row });
    }
    return { data: this.returning ? inserted : null, error: null };
  }

  then<R1 = DbResult, R2 = never>(
    onfulfilled?: ((value: DbResult) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

class FakeSupabase {
  constructor(private readonly store: Store) {}
  from(table: "leads" | "runs"): FakeQuery {
    return new FakeQuery(this.store, table);
  }
}

// ===== Mock del cliente admin =====

const hoisted = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("@/lib/supabase/admin", () => ({
  getAdminClient: () => hoisted.client,
}));

const { persistLeads } = await import("../lib/db/leads");
const { startRun, finishRun } = await import("../lib/db/runs");

// ===== Helpers de fixtures =====

let store: Store;

beforeEach(() => {
  store = { leads: [], runs: [], nextId: 1 };
  hoisted.client = new FakeSupabase(store);
});

/** Construye un `LeadRow` determinístico a partir de un índice. */
function makeLead(i: number): LeadRow {
  return {
    source: "hackernews",
    external_id: `ext-${i}`,
    content_hash: `hash-${i}`,
    title: `Lead ${i}`,
    body: "necesito un desarrollador",
    url: `https://example.com/${i}`,
    author: "alice",
    lang: "es",
    posted_at: "2026-05-16T00:00:00.000Z",
    raw: { i },
    prefilter_matched: ["necesito un desarrollador"],
    llm_status: "pending",
    notify_status: "pending",
  };
}

/** Lote de `n` leads consecutivos a partir de `start`. */
function makeLeads(n: number, start = 0): LeadRow[] {
  return Array.from({ length: n }, (_, k) => makeLead(start + k));
}

// ===== Tests =====

describe("persistLeads — deduplicación", () => {
  it("inserta un lote nuevo y devuelve new = N", async () => {
    const result = await persistLeads(makeLeads(4));

    expect(result).toEqual({ found: 4, new: 4 });
    expect(store.leads).toHaveLength(4);
  });

  it("reinsertar el mismo lote no duplica y devuelve new: 0", async () => {
    const rows = makeLeads(4);
    await persistLeads(rows);

    const result = await persistLeads(rows);

    expect(result).toEqual({ found: 4, new: 0 });
    expect(store.leads).toHaveLength(4);
  });

  it("en un lote mixto solo inserta los realmente nuevos", async () => {
    await persistLeads(makeLeads(3));

    // 3 repetidos + 2 nuevos.
    const result = await persistLeads([...makeLeads(3), ...makeLeads(2, 3)]);

    expect(result).toEqual({ found: 5, new: 2 });
    expect(store.leads).toHaveLength(5);
  });

  it("deduplica por (source, external_id) aunque cambie el content_hash", async () => {
    const [base] = makeLeads(1);
    await persistLeads([base]);

    // Mismo post editado: igual external_id, distinto content_hash.
    const edited: LeadRow = { ...base, content_hash: "hash-editado" };
    const result = await persistLeads([edited]);

    expect(result).toEqual({ found: 1, new: 0 });
    expect(store.leads).toHaveLength(1);
  });

  it("refresca last_seen_at de los items ya vistos", async () => {
    const rows = makeLeads(2);
    await persistLeads(rows);
    const before = store.leads.map((r) => r.last_seen_at as string);

    await new Promise((r) => setTimeout(r, 2));
    await persistLeads(rows);

    for (let i = 0; i < store.leads.length; i++) {
      expect(store.leads[i].last_seen_at).not.toBe(before[i]);
    }
  });

  it("un lote vacío no toca la base", async () => {
    expect(await persistLeads([])).toEqual({ found: 0, new: 0 });
    expect(store.leads).toHaveLength(0);
  });

  it("persiste leads que no pasaron el pre-filtro como skipped", async () => {
    const skipped: LeadRow = {
      ...makeLead(0),
      llm_status: "skipped",
      notify_status: "skipped",
    };

    const result = await persistLeads([skipped]);

    expect(result).toEqual({ found: 1, new: 1 });
    expect(store.leads[0]).toMatchObject({
      llm_status: "skipped",
      notify_status: "skipped",
    });
  });
});

describe("runs — startRun / finishRun", () => {
  it("startRun crea una fila en estado running", async () => {
    const id = await startRun("poll", "hackernews");

    expect(typeof id).toBe("number");
    const row = store.runs.find((r) => r.id === id);
    expect(row).toMatchObject({
      kind: "poll",
      source: "hackernews",
      status: "running",
    });
    expect(row?.finished_at).toBeUndefined();
  });

  it("startRun sin source deja source en null", async () => {
    const id = await startRun("health");

    expect(store.runs.find((r) => r.id === id)?.source).toBeNull();
  });

  it("finishRun cierra la fila con estado, contadores y finished_at", async () => {
    const id = await startRun("poll");

    await finishRun(id, {
      status: "ok",
      itemsFound: 10,
      itemsNew: 4,
      itemsProcessed: 10,
    });

    const row = store.runs.find((r) => r.id === id);
    expect(row).toMatchObject({
      status: "ok",
      items_found: 10,
      items_new: 4,
      items_processed: 10,
    });
    expect(typeof row?.finished_at).toBe("string");
  });

  it("finishRun registra el error de una corrida fallida", async () => {
    const id = await startRun("notify");

    await finishRun(id, { status: "error", error: "boom" });

    const row = store.runs.find((r) => r.id === id);
    expect(row).toMatchObject({ status: "error", error: "boom" });
  });
});

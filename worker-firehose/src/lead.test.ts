/**
 * Tests del gate (idioma + keywords) y del mapeo evento → LeadRow.
 *
 * El test clave es la INVARIANTE DE DEDUP: el `content_hash` que produce el
 * worker para un post tiene que ser idéntico al que produce el search-poll
 * (`lib/sources/bluesky.ts` → `toRawItem` → `contentHash`). Si divergen, el
 * mismo post entraría dos veces mientras ambos corren en paralelo. El test
 * reconstruye el `RawItem` del search-poll de forma independiente y compara.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { contentHash } from "@/lib/filter/normalize";
import type { Keyword } from "@/lib/filter/match";
import type { RawItem } from "@/lib/sources/types";

import { buildAtUri, buildLeadRow, gatePost } from "./lead";
import type { PostCreate } from "./jetstream";

/** Set de keywords mínimo, como el sembrado por la migración 0011. */
const KEYWORDS: Keyword[] = [
  { term: "necesito una página web", kind: "include", lang: "any" },
  { term: "busco desarrollador", kind: "include", lang: "any" },
  { term: "me ofrezco", kind: "exclude", lang: "any" },
];

/** Construye un PostCreate de prueba. */
function makePost(text: string, overrides: Partial<PostCreate> = {}): PostCreate {
  const base: PostCreate = {
    did: "did:plc:abc123",
    rkey: "3l3qo2vuowo2b",
    text,
    createdAt: "2026-06-14T10:00:00.000Z",
    timeUs: 1725911162329308,
    raw: { kind: "commit" },
  };
  return { ...base, ...overrides };
}

// ─── Capa 1: idioma ──────────────────────────────────────────────────────────

test("gatePost: descarta inglés", () => {
  const post = makePost(
    "I really need a developer to build my website as soon as possible please",
  );
  const gate = gatePost(post, KEYWORDS);
  assert.equal(gate.lang, "en");
  assert.equal(gate.passed, false);
});

test("gatePost: conserva 'other' (texto corto) si matchea keyword", () => {
  // Texto corto → franc no clasifica → 'other'; igual debe poder pasar la Capa 2.
  const post = makePost("busco desarrollador");
  const gate = gatePost(post, KEYWORDS);
  assert.notEqual(gate.lang, "en");
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.matched, ["busco desarrollador"]);
});

// ─── Capa 2: keywords ────────────────────────────────────────────────────────

test("gatePost: pasa español que matchea include (insensible a acentos)", () => {
  const post = makePost("Hola gente, necesito una pagina web para mi emprendimiento nuevo");
  const gate = gatePost(post, KEYWORDS);
  assert.equal(gate.passed, true);
  assert.deepEqual(gate.matched, ["necesito una página web"]);
});

test("gatePost: descarta español sin ninguna keyword", () => {
  const post = makePost("Qué lindo día para tomar unos mates en la plaza con amigos");
  const gate = gatePost(post, KEYWORDS);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.matched, []);
});

test("gatePost: una keyword exclude veta aunque haya include", () => {
  const post = makePost(
    "Soy dev y me ofrezco, pero también necesito una página web para un cliente",
  );
  const gate = gatePost(post, KEYWORDS);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.matched, ["me ofrezco"]);
});

// ─── Mapeo a LeadRow ─────────────────────────────────────────────────────────

test("buildLeadRow: campos exactos de la spec del worker", () => {
  const post = makePost("necesito una página web urgente para mi negocio");
  const row = buildLeadRow(post, "juan.bsky.social", "es", ["necesito una página web"]);

  assert.equal(row.source, "bluesky");
  assert.equal(row.external_id, "at://did:plc:abc123/app.bsky.feed.post/3l3qo2vuowo2b");
  assert.equal(row.url, "https://bsky.app/profile/juan.bsky.social/post/3l3qo2vuowo2b");
  assert.equal(row.author, "juan.bsky.social");
  assert.equal(row.lang, "es");
  assert.equal(row.posted_at, "2026-06-14T10:00:00.000Z");
  assert.equal(row.llm_status, "pending");
  assert.equal(row.notify_status, "pending");
  assert.equal(row.contact_channel, "bluesky");
  assert.equal(row.contact_key, "did:plc:abc123");
  assert.deepEqual(row.contact_ref, { did: "did:plc:abc123" });
  assert.equal(row.contact_handle, "@juan.bsky.social");
  assert.deepEqual(row.prefilter_matched, ["necesito una página web"]);
});

test("buildAtUri: forma at:// esperada", () => {
  assert.equal(
    buildAtUri("did:plc:abc123", "3l3qo2vuowo2b"),
    "at://did:plc:abc123/app.bsky.feed.post/3l3qo2vuowo2b",
  );
});

// ─── INVARIANTE DE DEDUP: mismo content_hash que el search-poll ──────────────

/**
 * Reconstrucción independiente del `RawItem` tal como lo arma `toRawItem` del
 * search-poll (`lib/sources/bluesky.ts`), para un post equivalente. El
 * `content_hash` se calcula sobre `title + ' ' + body + ' ' + url`.
 */
function searchPollRawItem(text: string, handle: string, rkey: string): RawItem {
  const trimmed = text.trim();
  const firstLine = trimmed.split("\n").find((line) => line.length > 0) ?? "";
  const TITLE_MAX = 120;
  const truncate = (s: string, max: number): string =>
    s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
  return {
    externalId: `at://did:plc:abc123/app.bsky.feed.post/${rkey}`,
    title: firstLine ? truncate(firstLine, TITLE_MAX) : "Bluesky post",
    body: trimmed,
    url: `https://bsky.app/profile/${handle}/post/${rkey}`,
    author: handle,
    postedAt: null,
    raw: {},
    contact: { channel: "bluesky", key: "did:plc:abc123", ref: {}, handle: `@${handle}` },
  };
}

test("content_hash coincide con el del search-poll (dedup perfecto)", () => {
  const cases = [
    "necesito una página web para mi negocio",
    "Primera línea\nSegunda línea con más texto\ny una tercera",
    "  texto con espacios raros   y saltos\n\n", // se trimea/normaliza
    "X".repeat(300), // dispara el truncate del título a 120
  ];
  for (const text of cases) {
    const handle = "juan.bsky.social";
    const rkey = "3l3qo2vuowo2b";
    const post = makePost(text, { rkey });

    // Hash del worker (vía buildLeadRow).
    const workerRow = buildLeadRow(post, handle, "es", []);

    // Hash del search-poll (reconstrucción independiente).
    const pollItem = searchPollRawItem(text, handle, rkey);
    const pollHash = contentHash(pollItem);

    assert.equal(
      workerRow.content_hash,
      pollHash,
      `content_hash divergió para: ${JSON.stringify(text.slice(0, 40))}`,
    );
    // Y el external_id (segundo índice único) también debe coincidir.
    assert.equal(workerRow.external_id, pollItem.externalId);
  }
});

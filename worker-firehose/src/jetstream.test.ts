/**
 * Tests del parsing/extracción de eventos del Jetstream.
 *
 * El fixture replica el shape oficial de un evento `commit` de
 * `bluesky-social/jetstream` (ver README). Corre con el runner nativo de Node
 * (`node --test`) vía tsx.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { extractPostCreate, parseEvent, readTimeUs, type JetstreamEvent } from "./jetstream";

/** Evento `commit`/`create` de un post, con la forma real del Jetstream. */
function postCreateEvent(text: string): JetstreamEvent {
  return {
    did: "did:plc:abc123",
    time_us: 1725911162329308,
    kind: "commit",
    commit: {
      rev: "3l3qo2vutsw2b",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3l3qo2vuowo2b",
      cid: "bafyreib2",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: "2026-06-14T10:00:00.000Z",
        langs: ["es"],
      },
    },
  };
}

test("parseEvent: parsea JSON válido y rechaza basura", () => {
  assert.equal(parseEvent("no es json"), null);
  assert.equal(parseEvent("123"), null); // no es objeto
  const ev = parseEvent(JSON.stringify(postCreateEvent("hola")));
  assert.ok(ev);
  assert.equal(ev?.kind, "commit");
});

test("extractPostCreate: extrae un post create válido", () => {
  const post = extractPostCreate(postCreateEvent("necesito una página web"));
  assert.ok(post);
  assert.equal(post?.did, "did:plc:abc123");
  assert.equal(post?.rkey, "3l3qo2vuowo2b");
  assert.equal(post?.text, "necesito una página web");
  assert.equal(post?.createdAt, "2026-06-14T10:00:00.000Z");
  assert.equal(post?.timeUs, 1725911162329308);
});

test("extractPostCreate: descarta lo que no es un post create", () => {
  // identity / otros kinds
  assert.equal(extractPostCreate({ kind: "identity", did: "did:plc:x" }), null);

  // operation != create (delete/update)
  const del = postCreateEvent("x");
  del.commit!.operation = "delete";
  assert.equal(extractPostCreate(del), null);

  // otra colección (like, repost, follow…)
  const like = postCreateEvent("x");
  like.commit!.collection = "app.bsky.feed.like";
  assert.equal(extractPostCreate(like), null);

  // texto vacío o sólo espacios → no es un lead
  assert.equal(extractPostCreate(postCreateEvent("")), null);
  assert.equal(extractPostCreate(postCreateEvent("   \n  ")), null);

  // falta did o rkey
  const noDid = postCreateEvent("hola mundo largo");
  noDid.did = undefined;
  assert.equal(extractPostCreate(noDid), null);
});

test("extractPostCreate: createdAt ausente queda null", () => {
  const ev = postCreateEvent("necesito un desarrollador urgente");
  delete ev.commit!.record!.createdAt;
  const post = extractPostCreate(ev);
  assert.ok(post);
  assert.equal(post?.createdAt, null);
});

test("readTimeUs: devuelve el número o null", () => {
  assert.equal(readTimeUs({ time_us: 42 }), 42);
  assert.equal(readTimeUs({ time_us: "42" as unknown as number }), null);
  assert.equal(readTimeUs({}), null);
});

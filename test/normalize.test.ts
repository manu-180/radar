import { describe, expect, it } from "vitest";

import { contentHash, detectLang, normalizeText } from "../lib/filter/normalize";
import type { RawItem } from "../lib/sources/types";

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

describe("normalizeText", () => {
  it("pasa a minúsculas y elimina acentos y diacríticos", () => {
    expect(normalizeText("Necesito UN Desarrollador")).toBe(
      "necesito un desarrollador",
    );
    expect(normalizeText("Programación Rápida en Español")).toBe(
      "programacion rapida en espanol",
    );
  });

  it("colapsa espacios repetidos y recorta los extremos", () => {
    expect(normalizeText("  hola   mundo \t cruel  ")).toBe("hola mundo cruel");
  });

  it("deja igual un texto ya normalizado", () => {
    expect(normalizeText("necesito un desarrollador")).toBe(
      "necesito un desarrollador",
    );
  });
});

describe("contentHash", () => {
  it("devuelve un SHA-256 en hexadecimal (64 caracteres)", () => {
    expect(contentHash(makeItem({ title: "hola mundo" }))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("es estable ante cambios de casing y de acentos", () => {
    const original = makeItem({
      title: "Necesito un Desarrollador",
      body: "Para mi Página Web",
      url: "https://ejemplo.com/post/1",
    });
    const variante = makeItem({
      title: "necesito un desarrollador",
      body: "para mi pagina web",
      url: "https://ejemplo.com/post/1",
    });
    expect(contentHash(variante)).toBe(contentHash(original));
  });

  it("cambia cuando cambia el contenido real", () => {
    const desarrollador = makeItem({
      title: "Necesito un desarrollador",
      url: "https://ejemplo.com/post/1",
    });
    const disenador = makeItem({
      title: "Necesito un diseñador",
      url: "https://ejemplo.com/post/1",
    });
    expect(contentHash(disenador)).not.toBe(contentHash(desarrollador));
  });
});

describe("detectLang", () => {
  it("detecta español en una frase clara", () => {
    expect(
      detectLang(
        "Necesito un desarrollador web para construir mi tienda online",
      ),
    ).toBe("es");
  });

  it("detecta inglés en una frase clara", () => {
    expect(
      detectLang(
        "I am looking for a web developer to build my online store",
      ),
    ).toBe("en");
  });

  it("devuelve 'other' en textos demasiado cortos para confiar", () => {
    expect(detectLang("hola")).toBe("other");
    expect(detectLang("ok thanks")).toBe("other");
  });
});

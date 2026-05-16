import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithRetry } from "../lib/http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchWithRetry", () => {
  it("reintenta ante un 503 y luego resuelve con la respuesta 2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("transitorio", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://api.test/recurso", {
      baseDelayMs: 0,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("corta por timeout y lanza un error descriptivo con la URL", async () => {
    // `fetch` que nunca resuelve por sí solo: sólo termina cuando se aborta
    // su `signal`, simulando un request colgado que el timeout debe cortar.
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("https://api.test/colgado", {
        timeoutMs: 10,
        retries: 1,
        baseDelayMs: 0,
      }),
    ).rejects.toThrow(/api\.test\/colgado/);
    // Primer intento + 1 reintento, ambos cortados por timeout.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lanza de inmediato ante un status no recuperable (404)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("no existe", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("https://api.test/falta", { baseDelayMs: 0 }),
    ).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

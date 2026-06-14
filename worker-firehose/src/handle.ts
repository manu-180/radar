/**
 * Resolución de DID → handle, con caché.
 *
 * El firehose entrega el `did` del autor pero no su handle, y la URL pública del
 * post (`https://bsky.app/profile/{handle}/post/{rkey}`) — que entra al
 * `content_hash` — necesita el handle. Lo resolvemos con
 * `com.atproto.repo.describeRepo` (query GET, sin auth), que devuelve `{ did,
 * handle, ... }`.
 *
 * Verificado contra el lexicon oficial de atproto: `describeRepo` es de tipo
 * `query` (GET), toma el parámetro `repo` (handle o DID) y su salida incluye
 * `handle` y `did`. Se usa el host `api.bsky.app` (el mismo que el search-poll):
 * `public.api.bsky.app` está bloqueado a nivel CDN para algunos endpoints (ver
 * `lib/sources/bluesky.ts`).
 *
 * Sólo se resuelve para los SOBREVIVIENTES del filtro (pocos por día), así que el
 * volumen de requests es bajo; aun así cacheamos por DID para no repetir.
 */

import { log } from "./log";

/** Forma parcial de la respuesta de `describeRepo` (sólo lo que usamos). */
interface DescribeRepoResponse {
  handle?: unknown;
  did?: unknown;
}

/** Tope de entradas de la caché de handles, para no crecer sin límite. */
const CACHE_MAX = 5_000;

/** Timeout de la request de resolución. */
const RESOLVE_TIMEOUT_MS = 8_000;

/** `User-Agent` propio (mismo estilo que el adaptador de Bluesky). */
const USER_AGENT = "LeadDetector/1.0 (+bluesky-firehose-worker)";

/**
 * Resolvedor de handles con caché en memoria.
 *
 * La caché es un `Map` con expulsión FIFO simple al llegar a {@link CACHE_MAX}:
 * el universo de autores que pasan el filtro es chico y los DIDs no cambian de
 * handle seguido, así que no hace falta nada más sofisticado (ni TTL).
 */
export class HandleResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly apiBaseUrl: string) {}

  /**
   * Devuelve el handle del `did`, o `null` si no se pudo resolver.
   *
   * Cachea los aciertos. Los fallos NO se cachean (para reintentar la próxima
   * vez que aparezca ese autor): un fallo suele ser transitorio (red, rate
   * limit) y perder el handle significa perder el lead.
   */
  async resolve(did: string): Promise<string | null> {
    const cached = this.cache.get(did);
    if (cached !== undefined) return cached;

    const handle = await this.fetchHandle(did);
    if (handle) this.remember(did, handle);
    return handle;
  }

  /** Guarda en caché expulsando la entrada más vieja si se llenó. */
  private remember(did: string, handle: string): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(did, handle);
  }

  /** Pega a `describeRepo` y extrae el handle; `null` ante cualquier fallo. */
  private async fetchHandle(did: string): Promise<string | null> {
    const params = new URLSearchParams({ repo: did });
    const url = `${this.apiBaseUrl}/xrpc/com.atproto.repo.describeRepo?${params}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        log("warn", "describeRepo devolvió estado no-OK", { did, status: res.status });
        return null;
      }
      const data = (await res.json()) as DescribeRepoResponse;
      const handle = data.handle;
      // `handle.invalid` es el placeholder de atproto para handles no resueltos:
      // no sirve para armar una URL pública, así que lo tratamos como fallo.
      if (typeof handle === "string" && handle.length > 0 && handle !== "handle.invalid") {
        return handle;
      }
      log("warn", "describeRepo no devolvió un handle válido", { did });
      return null;
    } catch (err) {
      log("warn", "Falló la resolución de handle", {
        did,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Tamaño actual de la caché (para métricas/tests). */
  get size(): number {
    return this.cache.size;
  }
}

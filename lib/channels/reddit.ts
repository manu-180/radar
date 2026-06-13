/**
 * Adaptador de canal: Reddit (OAuth "script app", DMs vía /api/compose).
 *
 * ⚠️ Canal GATEADO. Reddit es agresivo con los DMs automatizados: limita por
 * rate y banea cuentas que mandan privados de forma programática. Por eso este
 * canal viene apagado por defecto en el autopilot y sólo se activa con setup
 * explícito (las tres credenciales `REDDIT_*`). Tratarlo como último recurso.
 *
 * A diferencia de la *fuente* de Reddit (lectura pública sin auth), el *canal*
 * necesita OAuth: una "script app" con `client_id`/`client_secret` y un
 * `refresh_token` de la cuenta que conversa.
 *
 * Flujo:
 *  - Token: `POST /api/v1/access_token` (Basic auth `client_id:client_secret`,
 *    body `grant_type=refresh_token&refresh_token=...`) → `{access_token}`,
 *    cacheado con TTL.
 *  - Enviar:  `POST oauth.reddit.com/api/compose` (form `api_type=json&to&
 *    subject&text`). `compose` no devuelve un id útil → `{id:null}`.
 *  - Recibir (polling): `GET oauth.reddit.com/message/unread?limit=25`, mapear
 *    cada mensaje, y `POST oauth.reddit.com/api/read_message` (`id=<fullnames>`)
 *    para marcarlos leídos.
 *
 * Todos los requests mandan `User-Agent: env.REDDIT_USER_AGENT` (Reddit bloquea
 * los User-Agent genéricos).
 */

import "server-only";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import type { Channel } from "@/types/autopilot";

import { registerChannel } from "./registry";
import type { ChannelAdapter, InboundMessage, OutboundTarget } from "./types";

const CHANNEL: Channel = "reddit";

const logger = createLogger({ module: "channels/reddit" });

/** Endpoint del token OAuth (host `www.reddit.com`). */
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

/** Host autenticado de la API (todo lo demás cuelga de acá). */
const OAUTH_HOST = "https://oauth.reddit.com";

/** Asunto fijo de los DMs salientes. */
const MESSAGE_SUBJECT = "Hola";

/** Mensajes a pedir por corrida de polling. */
const UNREAD_LIMIT = 25;

/** Margen que se le resta al `expires_in` para renovar el token antes de tiempo. */
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

/** Acceso seguro a una propiedad de un objeto desconocido. */
function prop(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  return (obj as Record<string, unknown>)[key];
}

/** Token de acceso cacheado y su expiración. */
interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Obtiene (o reusa) un access token vía el refresh token. El token se cachea
 * hasta poco antes de su expiración real (`expires_in` menos un margen).
 *
 * @param force Si `true`, ignora el cache y pide uno nuevo (ej. tras un `401`).
 */
async function getAccessToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.accessToken;
  }

  const basic = Buffer.from(
    `${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`,
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.REDDIT_REFRESH_TOKEN ?? "",
  });

  const response = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    userAgent: env.REDDIT_USER_AGENT,
    timeoutMs: 15_000,
    retries: 1,
  });

  const data = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error(
      "reddit: /access_token no devolvió access_token (refresh token inválido?).",
    );
  }

  const ttlMs =
    typeof data.expires_in === "number" && data.expires_in > 0
      ? data.expires_in * 1000
      : 60 * 60 * 1000;
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + Math.max(0, ttlMs - TOKEN_EXPIRY_MARGIN_MS),
  };
  logger.info("Token de Reddit obtenido");
  return cachedToken.accessToken;
}

/**
 * Hace un request autenticado contra `oauth.reddit.com`. Re-pide el token y
 * reintenta una vez ante `401`.
 *
 * @param path   Path bajo {@link OAUTH_HOST} (incluye la query si aplica).
 * @param method `GET` o `POST`.
 * @param form   Cuerpo form-encoded para los `POST`.
 */
async function oauthRequest(
  path: string,
  method: "GET" | "POST",
  form?: URLSearchParams,
): Promise<Response> {
  async function attempt(token: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    return fetchWithRetry(`${OAUTH_HOST}${path}`, {
      method,
      headers,
      body: method === "POST" ? (form ?? new URLSearchParams()).toString() : undefined,
      userAgent: env.REDDIT_USER_AGENT,
      timeoutMs: 15_000,
      retries: 0,
    });
  }

  let token = await getAccessToken();
  try {
    return await attempt(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("401")) {
      logger.warn("Token de Reddit vencido, renovando", { path });
      token = await getAccessToken(true);
      return attempt(token);
    }
    throw err;
  }
}

/** Forma parcial de un mensaje del listing de `message/unread`. */
interface RedditMessageData {
  name?: string | null;
  author?: string | null;
  body?: string | null;
}

interface RedditMessageChild {
  kind?: string;
  data?: RedditMessageData;
}

interface RedditUnreadListing {
  data?: { children?: RedditMessageChild[] };
}

/**
 * Adaptador de Reddit.
 *
 * Ver el encabezado del módulo: canal gateado, DMs automatizados son riesgosos.
 * Recibe por polling (`pollInbound`); no hay webhooks de Reddit.
 */
export const redditAdapter: ChannelAdapter = {
  channel: CHANNEL,

  isConfigured(): boolean {
    return Boolean(
      env.REDDIT_CLIENT_ID &&
        env.REDDIT_CLIENT_SECRET &&
        env.REDDIT_REFRESH_TOKEN,
    );
  },

  async send(target: OutboundTarget, text: string): Promise<{ id: string | null }> {
    // `contactKey` es el username de Reddit (sin el prefijo `u/`).
    const form = new URLSearchParams({
      api_type: "json",
      to: target.contactKey,
      subject: MESSAGE_SUBJECT,
      text,
    });

    const response = await oauthRequest("/api/compose", "POST", form);

    // `compose` devuelve `{json:{errors:[...]}}`: si hay errores, el envío
    // falló aunque el HTTP sea 200. Se chequea para lanzar (el motor lo marca
    // como `failed`) en vez de reportar un envío fantasma.
    const payload = (await response.json().catch(() => null)) as unknown;
    const errors = prop(prop(payload, "json"), "errors");
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(
        `reddit: /api/compose devolvió errores: ${JSON.stringify(errors)}`,
      );
    }

    logger.info("DM de Reddit enviado", { to: target.contactKey });
    // `compose` no devuelve un id de mensaje útil.
    return { id: null };
  },

  async pollInbound(): Promise<InboundMessage[]> {
    if (!this.isConfigured()) return [];

    let response: Response;
    try {
      response = await oauthRequest(
        `/message/unread?limit=${UNREAD_LIMIT}&raw_json=1`,
        "GET",
      );
    } catch (err) {
      logger.warn("message/unread falló; polling vacío", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const listing = (await response.json().catch(() => null)) as
      | RedditUnreadListing
      | null;
    const children = listing?.data?.children ?? [];

    const out: InboundMessage[] = [];
    const fullnames: string[] = [];

    for (const child of children) {
      const data = child?.data;
      const author = data?.author;
      const body = data?.body;
      const name = data?.name;
      if (
        typeof author !== "string" ||
        author.length === 0 ||
        typeof body !== "string" ||
        body.length === 0
      ) {
        continue;
      }

      out.push({
        channel: CHANNEL,
        contactKey: author,
        contactRef: {},
        contactHandle: `u/${author}`,
        text: body,
        providerMessageId:
          typeof name === "string" && name.length > 0 ? name : null,
      });
      if (typeof name === "string" && name.length > 0) fullnames.push(name);
    }

    // Marcar leídos para no reprocesarlos (best-effort).
    if (fullnames.length > 0) {
      try {
        await oauthRequest(
          "/api/read_message",
          "POST",
          new URLSearchParams({ id: fullnames.join(",") }),
        );
      } catch (err) {
        logger.warn("read_message falló; el dedup del motor cubre", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (out.length > 0) {
      logger.info("Entrantes de Reddit recolectados", { count: out.length });
    }
    return out;
  },
};

registerChannel(redditAdapter);

/**
 * Adaptador de canal: Bluesky (AT Protocol, DMs vía el chat service).
 *
 * A diferencia de la *fuente* de Bluesky (búsqueda pública sin auth), el *canal*
 * sí necesita una sesión autenticada con una app password: las DMs van por el
 * chat service `did:web:api.bsky.chat`, al que se llega proxeando los requests
 * a través del PDS (`https://bsky.social`) con el header `atproto-proxy`.
 *
 * Flujo:
 *  - Sesión: `com.atproto.server.createSession` con `{identifier, password}`
 *    devuelve `{accessJwt, did}`. El JWT se cachea en módulo con un TTL corto y
 *    se re-crea ante un `401`.
 *  - Enviar:  `chat.bsky.convo.getConvoForMembers?members=<did>` → `convo.id`,
 *    luego `chat.bsky.convo.sendMessage {convoId, message:{text}}` → `id`.
 *  - Recibir (polling): `chat.bsky.convo.listConvos` → para las convos con
 *    `unreadCount>0`, `chat.bsky.convo.getMessages` y se toman los mensajes
 *    cuyo `sender.did` !== el nuestro y más nuevos que el último visto; después
 *    se marca leída con `chat.bsky.convo.updateRead` para no reprocesar.
 *
 * Shapes verificados contra los lexicons oficiales de `chat.bsky.convo.*`
 * (`sendMessage`, `getConvoForMembers`, `listConvos`, `getMessages`,
 * `updateRead`) y `chat.bsky.convo.defs` (`messageView.id/text/sentAt/sender.did`,
 * `convoView.id/members/unreadCount`).
 */

import "server-only";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import type { Channel } from "@/types/autopilot";

import { registerChannel } from "./registry";
import type { ChannelAdapter, InboundMessage, OutboundTarget } from "./types";

const CHANNEL: Channel = "bluesky";

const logger = createLogger({ module: "channels/bluesky" });

/** Host del PDS por el que se proxean también los requests del chat. */
const PDS_HOST = "https://bsky.social";

/** DID del chat service; se proxea con el header `atproto-proxy`. */
const CHAT_PROXY = "did:web:api.bsky.chat#bsky_chat";

/** TTL de la sesión cacheada. El `accessJwt` real dura más; se renueva seguido por las dudas. */
const SESSION_TTL_MS = 60 * 60 * 1000;

/** `User-Agent` propio para identificar al cliente. */
const USER_AGENT = "LeadDetector/1.0 (+bluesky-channel-adapter)";

/** Mensajes a pedir por convo en cada corrida de polling. */
const MESSAGES_PER_CONVO = 50;

/** Convos a listar por corrida de polling. */
const CONVOS_LIMIT = 100;

/** Sesión autenticada cacheada: el JWT, nuestro DID y cuándo expira el cache. */
interface Session {
  accessJwt: string;
  did: string;
  /** Host del PDS real de la cuenta (no el entryway): por acá se proxea el chat. */
  pdsHost: string;
  expiresAt: number;
}

let cachedSession: Session | null = null;

/**
 * Extrae el host del PDS real de la cuenta desde el `didDoc` que devuelve
 * `createSession`. Las cuentas de la red de Bluesky NO viven en `bsky.social`
 * (su *entryway*) sino en hosts `*.host.bsky.network`; el chat service sólo se
 * proxea bien a través del PDS real. Si se usa el entryway, los métodos
 * `chat.bsky.*` devuelven 501 (MethodNotImplemented). Devuelve `null` si el
 * `didDoc` no trae el endpoint, para caer al `PDS_HOST` por defecto.
 */
function pdsHostFromDidDoc(
  didDoc:
    | { service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }> }
    | undefined,
): string | null {
  const svc = didDoc?.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  const endpoint = svc?.serviceEndpoint;
  return typeof endpoint === "string" && endpoint.startsWith("http") ? endpoint : null;
}

/**
 * Marca por convo del último mensaje procesado (su `sentAt` ISO). Evita
 * reprocesar entre corridas aun si `updateRead` no se reflejó al instante. El
 * motor además deduplica por `providerMessageId`, así que esto es defensa en
 * profundidad, no la única barrera.
 */
const lastSeenSentAt = new Map<string, string>();

/**
 * Crea (o reusa) una sesión autenticada con el PDS.
 *
 * @param force Si `true`, ignora el cache y re-autentica (ej. tras un `401`).
 */
async function getSession(force = false): Promise<Session> {
  const now = Date.now();
  if (!force && cachedSession && cachedSession.expiresAt > now) {
    return cachedSession;
  }

  const response = await fetchWithRetry(
    `${PDS_HOST}/xrpc/com.atproto.server.createSession`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: env.BLUESKY_IDENTIFIER,
        password: env.BLUESKY_APP_PASSWORD,
      }),
      userAgent: USER_AGENT,
      timeoutMs: 15_000,
      retries: 1,
    },
  );

  const data = (await response.json()) as {
    accessJwt?: string;
    did?: string;
    didDoc?: {
      service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
    };
  };
  if (!data.accessJwt || !data.did) {
    throw new Error(
      "bluesky: createSession no devolvió accessJwt/did (credenciales inválidas?).",
    );
  }

  // El chat se proxea por el PDS real de la cuenta, no por el entryway.
  const pdsHost = pdsHostFromDidDoc(data.didDoc) ?? PDS_HOST;
  cachedSession = {
    accessJwt: data.accessJwt,
    did: data.did,
    pdsHost,
    expiresAt: now + SESSION_TTL_MS,
  };
  logger.info("Sesión de Bluesky creada", { did: data.did, pdsHost });
  return cachedSession;
}

/**
 * Llama a un endpoint XRPC del chat service a través del PDS, con el header de
 * proxy y el bearer de la sesión. Re-autentica y reintenta una vez ante `401`.
 *
 * @param nsid   NSID del método (ej. `chat.bsky.convo.sendMessage`).
 * @param method `GET` (query) o `POST` (procedure).
 * @param init   `query` (params de la URL) o `body` (cuerpo JSON del POST).
 */
async function chatXrpc<T>(
  nsid: string,
  method: "GET" | "POST",
  init: { query?: Record<string, string | string[]>; body?: unknown } = {},
): Promise<T> {
  async function attempt(session: Session): Promise<Response> {
    let url = `${session.pdsHost}/xrpc/${nsid}`;
    if (init.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(init.query)) {
        if (Array.isArray(v)) for (const item of v) params.append(k, item);
        else params.set(k, v);
      }
      url += `?${params.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessJwt}`,
      "atproto-proxy": CHAT_PROXY,
    };
    if (method === "POST") headers["Content-Type"] = "application/json";

    return fetchWithRetry(url, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
      userAgent: USER_AGENT,
      timeoutMs: 15_000,
      // Sin reintentos internos acá: el 401 lo manejamos a mano (re-auth), y un
      // 5xx ya lo cubriría `fetchWithRetry` si subiéramos `retries`. Mantenemos
      // 0 para tener control total del flujo de re-autenticación.
      retries: 0,
    });
  }

  let session = await getSession();
  try {
    const response = await attempt(session);
    return (await response.json()) as T;
  } catch (err) {
    // `fetchWithRetry` lanza un error con el status embebido en el mensaje ante
    // un status no recuperable; un 401 significa sesión vencida → re-autenticar.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("401")) {
      logger.warn("Sesión de Bluesky vencida, re-autenticando", { nsid });
      session = await getSession(true);
      const response = await attempt(session);
      return (await response.json()) as T;
    }
    throw err;
  }
}

/** Respuesta de `getConvoForMembers`. */
interface ConvoForMembersResponse {
  convo?: { id?: string };
}

/** Respuesta de `sendMessage` (un `messageView`). */
interface SendMessageResponse {
  id?: string;
}

/** Un `convoView` de `listConvos`. */
interface ConvoView {
  id?: string;
  unreadCount?: number;
  members?: Array<{ did?: string; handle?: string }>;
}

/** Respuesta de `listConvos`. */
interface ListConvosResponse {
  convos?: ConvoView[];
}

/** Un `messageView` de `getMessages`. */
interface MessageView {
  id?: string;
  text?: string;
  sentAt?: string;
  sender?: { did?: string };
}

/** Respuesta de `getMessages`. */
interface GetMessagesResponse {
  messages?: MessageView[];
}

/** Convierte un `sentAt` ISO a epoch ms; `null` si falta o no parsea. */
function toEpoch(sentAt: string | undefined): number | null {
  if (!sentAt) return null;
  const ms = Date.parse(sentAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Recolecta los entrantes nuevos de una convo: mensajes ajenos (sender !== el
 * nuestro) más nuevos que el último visto. Devuelve los mensajes mapeados y el
 * `sentAt` más nuevo para avanzar la marca.
 */
function collectInbound(
  messages: MessageView[],
  ownDid: string,
  convoId: string,
  handle: string | null,
): { inbound: InboundMessage[]; newestSentAt: string | null } {
  const floorIso = lastSeenSentAt.get(convoId) ?? null;
  const floor = toEpoch(floorIso ?? undefined);

  const inbound: InboundMessage[] = [];
  let newestEpoch = floor ?? 0;
  let newestSentAt: string | null = floorIso;

  for (const message of messages) {
    const senderDid = message.sender?.did;
    if (!senderDid || senderDid === ownDid) continue; // saliente nuestro
    const text = message.text;
    if (typeof text !== "string" || text.length === 0) continue;

    const epoch = toEpoch(message.sentAt);
    // Ya procesado en una corrida anterior.
    if (floor !== null && epoch !== null && epoch <= floor) continue;

    inbound.push({
      channel: CHANNEL,
      contactKey: senderDid,
      contactRef: { did: senderDid },
      contactHandle: handle ? `@${handle}` : null,
      text,
      providerMessageId:
        typeof message.id === "string" && message.id.length > 0
          ? message.id
          : null,
    });

    if (epoch !== null && epoch > newestEpoch) {
      newestEpoch = epoch;
      newestSentAt = message.sentAt ?? newestSentAt;
    }
  }

  return { inbound, newestSentAt };
}

/**
 * Adaptador de Bluesky.
 *
 * Ver el encabezado del módulo para el comportamiento. Recibe por polling
 * (`pollInbound`): el chat service no tiene webhooks.
 */
export const blueskyAdapter: ChannelAdapter = {
  channel: CHANNEL,

  isConfigured(): boolean {
    return Boolean(env.BLUESKY_IDENTIFIER && env.BLUESKY_APP_PASSWORD);
  },

  async send(target: OutboundTarget, text: string): Promise<{ id: string | null }> {
    // `contactKey` es el DID del destinatario. Primero se resuelve (o crea) la
    // convo directa con ese miembro, luego se manda el mensaje a esa convo.
    const did = target.contactKey;

    const convo = await chatXrpc<ConvoForMembersResponse>(
      "chat.bsky.convo.getConvoForMembers",
      "GET",
      { query: { members: [did] } },
    );
    const convoId = convo.convo?.id;
    if (!convoId) {
      throw new Error(
        `bluesky: getConvoForMembers no devolvió convo.id para ${did}.`,
      );
    }

    const sent = await chatXrpc<SendMessageResponse>(
      "chat.bsky.convo.sendMessage",
      "POST",
      { body: { convoId, message: { text } } },
    );

    const id = typeof sent.id === "string" && sent.id.length > 0 ? sent.id : null;
    logger.info("DM de Bluesky enviado", { did, convoId, messageId: id });
    return { id };
  },

  async pollInbound(): Promise<InboundMessage[]> {
    if (!this.isConfigured()) return [];

    let session: Session;
    try {
      session = await getSession();
    } catch (err) {
      logger.warn("No se pudo crear la sesión de Bluesky; polling vacío", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    let list: ListConvosResponse;
    try {
      list = await chatXrpc<ListConvosResponse>(
        "chat.bsky.convo.listConvos",
        "GET",
        { query: { limit: String(CONVOS_LIMIT) } },
      );
    } catch (err) {
      logger.warn("listConvos falló; polling vacío", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const convos = Array.isArray(list.convos) ? list.convos : [];
    const out: InboundMessage[] = [];

    for (const convo of convos) {
      const convoId = convo.id;
      if (!convoId) continue;
      if (!convo.unreadCount || convo.unreadCount <= 0) continue;

      // Handle del otro miembro (el que no es nuestro DID), para el display.
      const otherHandle =
        convo.members?.find((m) => m.did && m.did !== session.did)?.handle ??
        null;

      let messagesResponse: GetMessagesResponse;
      try {
        messagesResponse = await chatXrpc<GetMessagesResponse>(
          "chat.bsky.convo.getMessages",
          "GET",
          { query: { convoId, limit: String(MESSAGES_PER_CONVO) } },
        );
      } catch (err) {
        logger.warn("getMessages falló para una convo, se continúa", {
          convoId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const messages = Array.isArray(messagesResponse.messages)
        ? messagesResponse.messages
        : [];
      const { inbound, newestSentAt } = collectInbound(
        messages,
        session.did,
        convoId,
        otherHandle,
      );
      out.push(...inbound);
      if (newestSentAt) lastSeenSentAt.set(convoId, newestSentAt);

      // Marcar leída para que no se reprocese (best-effort: si falla, la marca
      // por `sentAt` y el dedup del motor siguen cubriendo).
      try {
        await chatXrpc("chat.bsky.convo.updateRead", "POST", {
          body: { convoId },
        });
      } catch (err) {
        logger.warn("updateRead falló para una convo, se continúa", {
          convoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (out.length > 0) {
      logger.info("Entrantes de Bluesky recolectados", { count: out.length });
    }
    return out;
  },
};

registerChannel(blueskyAdapter);

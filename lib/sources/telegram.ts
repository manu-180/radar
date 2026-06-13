/**
 * Adaptador de fuente: Telegram (canales públicos vía MTProto / GramJS).
 *
 * Muchos canales públicos de Telegram funcionan como tablones de ofertas: gente
 * que publica que necesita un developer para un proyecto. Este adaptador lee los
 * mensajes nuevos de los `channels` configurados y los normaliza a {@link RawItem}.
 *
 * Telegram no expone una API HTTP simple para leer canales: usa el protocolo
 * MTProto a través de GramJS (paquete `telegram`), que necesita una sesión de
 * usuario autenticada. Esa sesión se genera una sola vez con
 * `scripts/telegram-login.ts` (paso 30) y viaja en `env.TELEGRAM_SESSION`.
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords ni
 * clasifica con IA. El polling es incremental — el cursor guarda, por canal, el
 * `id` del mensaje más nuevo ya visto; en cada corrida se piden solo los
 * mensajes con `id` mayor (parámetro `minId` de GramJS).
 *
 * ## Degradación elegante
 *
 * Telegram requiere tres variables (`TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
 * `TELEGRAM_SESSION`). Si alguna falta, `fetchItems` devuelve `{ items: [],
 * cursor }` sin lanzar error: la fuente queda inerte hasta configurarse y el
 * resto del sistema sigue intacto.
 *
 * Cada canal se baja de forma aislada: si uno falla (canal inexistente, privado,
 * timeout) se loguea y se sigue con los demás. Solo se lanza error si fallan
 * **todos** los canales configurados — eso ya es un fallo real de la fuente.
 */

import { Logger, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import { z } from "zod";

import { env } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { registerSource } from "@/lib/sources/registry";
import type {
  FetchResult,
  RawItem,
  SourceAdapter,
  SourceCursor,
} from "@/lib/sources/types";

/** Mensajes a pedir por canal en cada corrida. */
const MESSAGES_PER_CHANNEL = 100;

/** Largo máximo del título derivado de la primera línea del mensaje. */
const TITLE_MAX_LENGTH = 120;

/** Reintentos de conexión que GramJS hace antes de rendirse. */
const CONNECTION_RETRIES = 3;

/** Timeout defensivo para la conexión inicial al servidor de Telegram. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Timeout defensivo para la bajada de mensajes de un canal. */
const CHANNEL_TIMEOUT_MS = 30_000;

/** Pausa entre canales para no golpear los servidores ni gatillar FloodWait. */
const PAUSE_BETWEEN_CHANNELS_MS = 500;

/** Config propia de la fuente Telegram (columna `sources.config`). */
const configSchema = z.object({
  /** Canales públicos a monitorear; se acepta `@nombre`, `nombre` o la URL `t.me`. */
  channels: z.array(z.string().min(1)).default([]),
});

type TelegramConfig = z.infer<typeof configSchema>;

const log = createLogger({ source: "telegram" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza un canal del config a su `username` desnudo: descarta el prefijo
 * `@`, una URL `t.me`/`telegram.me` completa y cualquier path posterior. Los
 * usernames de Telegram no distinguen mayúsculas, así que se pasa a minúsculas
 * para que la clave del cursor sea estable.
 */
function normalizeChannel(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/**
 * Piso de un canal: el `id` del mensaje más nuevo ya visto, guardado en el
 * cursor. `0` si no hay (primera corrida) — `minId: 0` trae los más recientes.
 */
function readChannelFloor(cursor: SourceCursor, channel: string): number {
  const stored = cursor[channel];
  return typeof stored === "number" && Number.isFinite(stored) ? stored : 0;
}

/** Recorta `text` a `max` caracteres agregando una elipsis si lo excede. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Envuelve una promesa con un timeout defensivo: rechaza si `promise` no
 * resuelve dentro de `ms` milisegundos.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout tras ${ms}ms: ${label}`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Forma parcial de un mensaje de GramJS, con los campos que usamos.
 *
 * `fromId` y `sender` son best-effort para el contacto de v2: en posts de un
 * canal de difusión (broadcast) no hay remitente individual y vienen ausentes;
 * en grupos/supergrupos suele venir `fromId` (un `PeerUser` con `userId`) y, si
 * GramJS resolvió la entidad, un `sender` con `accessHash`.
 */
interface TelegramMessage {
  id: number;
  message?: string;
  date?: number;
  /** Remitente como `Peer`; en grupos es un `PeerUser` con `userId`. */
  fromId?: { userId?: unknown; className?: string } | null;
  /** Entidad del remitente ya resuelta (si GramJS la trajo). */
  sender?: { id?: unknown; accessHash?: unknown; username?: string | null; firstName?: string | null } | null;
}

/** Convierte un valor `bigInt`/number/string de GramJS a string; `null` si no se puede. */
function bigIntToString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  // GramJS usa una clase `Integer`/`BigInteger` con `toString` propio.
  if (typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function") {
    const s = (value as { toString(): string }).toString();
    return /^-?\d+$/.test(s) ? s : null;
  }
  return null;
}

/**
 * Arma el contacto (v2) de un mensaje **best-effort**.
 *
 * Sólo devuelve un contacto cuando hay un remitente individual identificable
 * (`fromId.userId` o `sender.id`): así, los posts de canales de difusión —sin
 * remitente individual— quedan sin contacto (se detecta el lead pero no se
 * auto-engancha). El `accessHash` se incluye si la entidad del remitente ya
 * estaba resuelta; sin él, el envío por el worker puede seguir funcionando si el
 * peer ya es conocido. Nunca lanza: ante cualquier forma inesperada, `null`.
 */
function toContact(message: TelegramMessage): RawItem["contact"] {
  const userId =
    bigIntToString(message.fromId?.userId) ?? bigIntToString(message.sender?.id);
  if (!userId) return null;

  const accessHash = bigIntToString(message.sender?.accessHash);
  const username =
    typeof message.sender?.username === "string" && message.sender.username.length > 0
      ? message.sender.username
      : null;
  const firstName =
    typeof message.sender?.firstName === "string" && message.sender.firstName.length > 0
      ? message.sender.firstName
      : null;

  return {
    channel: "telegram",
    key: userId,
    // `accessHash` opaco en `ref`; el worker lo usa para direccionar el DM.
    ref: accessHash ? { accessHash } : {},
    handle: username ? `@${username}` : firstName,
  };
}

/** Mapea un mensaje de un canal a la forma neutral {@link RawItem}. */
function toRawItem(message: TelegramMessage, channel: string): RawItem {
  const text = (message.message ?? "").trim();
  const firstLine = text.split("\n").find((line) => line.length > 0) ?? "";

  return {
    // El canal prefija el id para que sea único entre canales.
    externalId: `${channel}:${message.id}`,
    title: firstLine
      ? truncate(firstLine, TITLE_MAX_LENGTH)
      : `Mensaje de @${channel}`,
    body: text,
    url: `https://t.me/${channel}/${message.id}`,
    // El canal viaja en `author`: es quien "publica" desde la óptica del lead.
    author: channel,
    postedAt:
      typeof message.date === "number"
        ? new Date(message.date * 1000).toISOString()
        : null,
    raw: message,
    // Best-effort: sólo presente si hay un remitente individual identificable.
    contact: toContact(message),
  };
}

/**
 * Adaptador de Telegram.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const telegramAdapter: SourceAdapter = {
  slug: "telegram",
  displayName: "Telegram",
  configSchema,

  async fetchItems(
    rawConfig: unknown,
    cursor: SourceCursor,
  ): Promise<FetchResult> {
    const config: TelegramConfig = configSchema.parse(rawConfig);

    // Degradación elegante: sin las TELEGRAM_* la fuente queda inerte.
    const apiId = Number(env.TELEGRAM_API_ID);
    const apiHash = env.TELEGRAM_API_HASH;
    const sessionString = env.TELEGRAM_SESSION;
    if (
      !env.TELEGRAM_API_ID ||
      !apiHash ||
      !sessionString ||
      !Number.isInteger(apiId) ||
      apiId <= 0
    ) {
      log.info("Variables TELEGRAM_* incompletas; la fuente queda inerte");
      return { items: [], cursor };
    }

    // Dedup y normalización de los canales configurados.
    const channels = [
      ...new Set(config.channels.map(normalizeChannel)),
    ].filter((channel) => channel.length > 0);
    if (channels.length === 0) {
      log.info("Sin canales configurados; corrida vacía");
      return { items: [], cursor: {} };
    }

    // `baseLogger` en silencio: GramJS es muy verboso por defecto y sus líneas
    // ensucian el log estructurado del pipeline.
    const client = new TelegramClient(
      new StringSession(sessionString),
      apiId,
      apiHash,
      { connectionRetries: CONNECTION_RETRIES, baseLogger: new Logger(LogLevel.NONE) },
    );

    const items: RawItem[] = [];
    const nextCursor: SourceCursor = {};
    let failures = 0;

    try {
      await withTimeout(
        client.connect(),
        CONNECT_TIMEOUT_MS,
        "conexión a Telegram",
      );

      for (let i = 0; i < channels.length; i++) {
        const channel = channels[i];
        if (i > 0) await sleep(PAUSE_BETWEEN_CHANNELS_MS);

        const floor = readChannelFloor(cursor, channel);

        let messages: TelegramMessage[];
        try {
          messages = (await withTimeout(
            // `minId` es exclusivo: solo trae mensajes con `id` mayor a `floor`.
            client.getMessages(channel, {
              limit: MESSAGES_PER_CHANNEL,
              minId: floor,
            }),
            CHANNEL_TIMEOUT_MS,
            `canal @${channel}`,
          )) as unknown as TelegramMessage[];
        } catch (err) {
          failures++;
          // El cursor del canal caído se conserva para no perder el piso.
          nextCursor[channel] = floor;
          log.warn("Falló un canal, se continúa con el resto", {
            channel,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        // El cursor avanza al mayor `id` visto, aunque el mensaje se descarte
        // por estar vacío (ej. posts de solo-media): así no se re-evalúa.
        let maxId = floor;
        let kept = 0;
        for (const message of messages) {
          if (typeof message.id !== "number") continue;
          maxId = Math.max(maxId, message.id);

          const item = toRawItem(message, channel);
          if (item.body.length === 0) continue;
          items.push(item);
          kept++;
        }
        nextCursor[channel] = maxId;

        log.info("Canal procesado", {
          channel,
          fetched: messages.length,
          kept,
        });
      }
    } finally {
      // Desconexión best-effort: que un fallo al cerrar no tape el error real.
      try {
        await client.disconnect();
      } catch {
        // Ignorado a propósito.
      }
    }

    // Si fallaron todos los canales es un fallo real de la fuente, no una
    // corrida vacía legítima.
    if (failures === channels.length) {
      throw new Error(
        `telegram: fallaron los ${failures} canal(es) configurados.`,
      );
    }

    log.info("Corrida de polling completa", {
      items: items.length,
      channels: channels.length,
      failures,
    });

    return { items, cursor: nextCursor };
  },
};

registerSource(telegramAdapter);

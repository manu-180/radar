/**
 * Adaptador de fuente: Discord.
 *
 * Muchos servidores de Discord tienen canales que funcionan como tablón de
 * trabajos: gente que postea que necesita un developer para un proyecto. Este
 * adaptador lee los mensajes nuevos de los canales configurados y los normaliza
 * a {@link RawItem}.
 *
 * Se usa la **API REST por polling**, no una conexión gateway persistente:
 * `GET /channels/{id}/messages?after={id}` es stateless y encaja con el modelo
 * de cron del sistema —no hace falta un proceso siempre activo—. El bot tiene
 * que estar en el servidor y con permiso de lectura sobre el canal; ese setup
 * manual único está documentado en la sección Discord del README (paso 32).
 *
 * El adaptador **solo trae y normaliza**: no aplica el pre-filtro de keywords ni
 * clasifica con IA. El polling es incremental — el cursor guarda, por canal, el
 * `id` del mensaje más nuevo ya visto; en cada corrida se piden solo los
 * mensajes con `id` mayor (parámetro `after` de la API de Discord).
 *
 * ## Degradación elegante
 *
 * Discord requiere `DISCORD_BOT_TOKEN`. Si falta, `fetchItems` devuelve
 * `{ items: [], cursor }` sin lanzar error: la fuente queda inerte hasta
 * configurarse y el resto del sistema sigue intacto.
 *
 * Cada canal se baja de forma aislada: si uno falla (canal inexistente, sin
 * permiso, timeout) se loguea y se sigue con los demás. Solo se lanza error si
 * fallan **todos** los canales configurados — eso ya es un fallo real de la
 * fuente.
 */

import { z } from "zod";

import { env } from "@/lib/env";
import { fetchWithRetry } from "@/lib/http";
import { createLogger } from "@/lib/logger";
import { registerSource } from "@/lib/sources/registry";
import type {
  FetchResult,
  RawItem,
  SourceAdapter,
  SourceCursor,
} from "@/lib/sources/types";

/** Versión fija de la API REST de Discord. */
const DISCORD_API = "https://discord.com/api/v10";

/** Mensajes a pedir por canal en cada corrida (máximo que admite el endpoint). */
const MESSAGES_PER_CHANNEL = 100;

/** Largo máximo del título derivado de la primera línea del mensaje. */
const TITLE_MAX_LENGTH = 120;

/** Pausa entre canales para no golpear la API de Discord. */
const PAUSE_BETWEEN_CHANNELS_MS = 500;

/** Config propia de la fuente Discord (columna `sources.config`). */
const configSchema = z.object({
  /** Canales a monitorear; los IDs salen del setup manual del paso 32. */
  channels: z
    .array(
      z.object({
        /** Nombre legible del canal; solo para logs. */
        name: z.string().min(1),
        /** Snowflake del canal — lo usa el endpoint de mensajes. */
        channelId: z.string().min(1),
        /** Snowflake del servidor — solo se usa para armar la URL pública. */
        guildId: z.string().min(1),
      }),
    )
    .default([]),
});

type DiscordConfig = z.infer<typeof configSchema>;
type DiscordChannel = DiscordConfig["channels"][number];

const log = createLogger({ source: "discord" });

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recorta `text` a `max` caracteres agregando una elipsis si lo excede. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Devuelve el mayor de dos snowflakes de Discord.
 *
 * Los snowflakes son enteros de 64 bits que exceden `Number.MAX_SAFE_INTEGER`,
 * así que comparar como `number` perdería precisión: se comparan como `BigInt`.
 * Un string vacío (sin cursor previo) cuenta como el menor posible.
 */
function maxSnowflake(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** Piso de un canal: el `id` del mensaje más nuevo ya visto en el cursor. */
function readChannelFloor(cursor: SourceCursor, channelId: string): string {
  const stored = cursor[channelId];
  return typeof stored === "string" ? stored : "";
}

/** Forma parcial de un mensaje de la API de Discord, con los campos que usamos. */
interface DiscordMessage {
  id: string;
  content?: string;
  timestamp?: string;
  author?: {
    username?: string;
    global_name?: string | null;
  };
}

/**
 * Trae los mensajes nuevos de un canal vía `GET /channels/{id}/messages`.
 *
 * `after` es exclusivo: solo devuelve mensajes con `id` mayor a `floor`. En la
 * primera corrida (sin cursor) se omite y la API devuelve los más recientes.
 */
async function fetchChannelMessages(
  channelId: string,
  floor: string,
  token: string,
): Promise<DiscordMessage[]> {
  let url =
    `${DISCORD_API}/channels/${encodeURIComponent(channelId)}/messages` +
    `?limit=${MESSAGES_PER_CHANNEL}`;
  if (floor) url += `&after=${encodeURIComponent(floor)}`;

  const response = await fetchWithRetry(url, {
    headers: {
      // Discord exige el prefijo `Bot ` para tokens de bot.
      Authorization: `Bot ${token}`,
    },
  });
  return (await response.json()) as DiscordMessage[];
}

/** Mapea un mensaje de Discord a la forma neutral {@link RawItem}. */
function toRawItem(message: DiscordMessage, channel: DiscordChannel): RawItem {
  const text = (message.content ?? "").trim();
  const firstLine = text.split("\n").find((line) => line.length > 0) ?? "";
  const author =
    message.author?.global_name?.trim() ||
    message.author?.username?.trim() ||
    null;

  return {
    // El prefijo `discord:` mantiene el id único entre fuentes.
    externalId: `discord:${message.id}`,
    title: firstLine
      ? truncate(firstLine, TITLE_MAX_LENGTH)
      : `Mensaje en #${channel.name}`,
    body: text,
    url:
      `https://discord.com/channels/` +
      `${channel.guildId}/${channel.channelId}/${message.id}`,
    author,
    postedAt: message.timestamp ?? null,
    raw: message,
  };
}

/**
 * Adaptador de Discord.
 *
 * Ver el encabezado del módulo para la descripción del comportamiento.
 */
export const discordAdapter: SourceAdapter = {
  slug: "discord",
  displayName: "Discord",
  configSchema,

  async fetchItems(
    rawConfig: unknown,
    cursor: SourceCursor,
  ): Promise<FetchResult> {
    const config: DiscordConfig = configSchema.parse(rawConfig);

    // Degradación elegante: sin el token la fuente queda inerte.
    const token = env.DISCORD_BOT_TOKEN;
    if (!token) {
      log.info("DISCORD_BOT_TOKEN no está seteado; la fuente queda inerte");
      return { items: [], cursor };
    }

    // Dedup de canales por `channelId` (la clave del cursor).
    const seen = new Set<string>();
    const channels = config.channels.filter((channel) => {
      if (seen.has(channel.channelId)) return false;
      seen.add(channel.channelId);
      return true;
    });
    if (channels.length === 0) {
      log.info("Sin canales configurados; corrida vacía");
      return { items: [], cursor: {} };
    }

    const items: RawItem[] = [];
    const nextCursor: SourceCursor = {};
    let failures = 0;

    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      if (i > 0) await sleep(PAUSE_BETWEEN_CHANNELS_MS);

      const floor = readChannelFloor(cursor, channel.channelId);

      let messages: DiscordMessage[];
      try {
        messages = await fetchChannelMessages(channel.channelId, floor, token);
      } catch (err) {
        failures++;
        // El cursor del canal caído se conserva para no perder el piso.
        nextCursor[channel.channelId] = floor;
        log.warn("Falló un canal, se continúa con el resto", {
          channel: channel.name,
          channelId: channel.channelId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // El cursor avanza al mayor `id` visto, aunque el mensaje se descarte por
      // estar vacío (ej. posts de solo-media): así no se re-evalúa.
      let maxId = floor;
      let kept = 0;
      for (const message of messages) {
        if (typeof message.id !== "string") continue;
        maxId = maxSnowflake(maxId, message.id);

        const item = toRawItem(message, channel);
        if (item.body.length === 0) continue;
        items.push(item);
        kept++;
      }
      nextCursor[channel.channelId] = maxId;

      log.info("Canal procesado", {
        channel: channel.name,
        fetched: messages.length,
        kept,
      });
    }

    // Si fallaron todos los canales es un fallo real de la fuente, no una
    // corrida vacía legítima.
    if (failures === channels.length) {
      throw new Error(
        `discord: fallaron los ${failures} canal(es) configurados.`,
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

registerSource(discordAdapter);

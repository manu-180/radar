/**
 * Registry de adaptadores de canal.
 *
 * Espejo de `lib/sources/registry.ts`: cada canal se auto-registra al importarse
 * (efecto de lado en `lib/channels/index.ts`). El motor de conversación resuelve
 * el adapter por su slug de canal, sin conocer las implementaciones concretas.
 */

import "server-only";

import type { Channel } from "@/types/autopilot";

import type { ChannelAdapter } from "./types";

const registry = new Map<Channel, ChannelAdapter>();

/** Registra un canal. Lanza si el slug ya estaba tomado (error de programación). */
export function registerChannel(adapter: ChannelAdapter): void {
  if (registry.has(adapter.channel)) {
    throw new Error(`Canal ya registrado: ${adapter.channel}`);
  }
  registry.set(adapter.channel, adapter);
}

/** Devuelve el adapter de un canal, o `undefined` si no está registrado. */
export function getChannel(channel: string): ChannelAdapter | undefined {
  return registry.get(channel as Channel);
}

/** Lista todos los canales registrados. */
export function listChannels(): ChannelAdapter[] {
  return [...registry.values()];
}

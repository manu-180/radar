/**
 * Punto de entrada de los canales: importar este módulo registra todos los
 * adapters (efecto de lado), igual que `lib/sources/index.ts`.
 *
 * El orden de import sigue el de preferencia de contacto (`CHANNELS`): telegram,
 * bluesky, whatsapp, reddit. Cada módulo llama a `registerChannel` al cargarse;
 * el registry lanza si un slug se duplica (error de programación).
 */

import "server-only";

// Imports por efecto de lado: cada uno se auto-registra en el registry.
import "./telegram";
import "./bluesky";
import "./whatsapp";
import "./reddit";

export { getChannel, listChannels, registerChannel } from "./registry";

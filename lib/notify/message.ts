/**
 * Armador del mensaje de WhatsApp para un lead.
 *
 * Módulo puro: transforma una fila de lead ya clasificada en el texto que se
 * le manda al dueño del sistema. No hace fetch ni toca la base — solo formatea.
 * Lo usan la ruta de notificación (paso 17) y, por extensión, cualquier flujo
 * que necesite avisar un lead.
 *
 * El texto usa el formato de WhatsApp: `*negrita*`, `_cursiva_`, y las URLs
 * sueltas se vuelven clickeables solas.
 */

import { env } from "@/lib/env";
import { sourceDisplayName } from "@/lib/sources/display";
import type { Tables } from "@/types/database";

/** Largo máximo del extracto del post (título + cuerpo). */
const EXCERPT_MAX_LENGTH = 280;

/**
 * Campos de un lead que necesita el armado del mensaje. Es un subconjunto de
 * la fila de `leads`, así cualquier objeto con estos campos sirve de entrada.
 */
export type LeadForMessage = Pick<
  Tables<"leads">,
  "id" | "source" | "category" | "score" | "title" | "body" | "url" | "suggested_reply"
>;

/**
 * Recorta `text` a `max` caracteres cortando en un límite de palabra y
 * agregando una elipsis. Colapsa los espacios sobrantes alrededor de los
 * saltos de línea para que el extracto quede compacto.
 */
function excerpt(text: string, max: number): string {
  const clean = text.replace(/[ \t]+\n/g, "\n").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${trimmed.trimEnd()}…`;
}

/**
 * Arma el aviso de WhatsApp para un lead.
 *
 * El mensaje incluye, separados por líneas en blanco: un título en negrita con
 * la fuente, la categoría y el score, un extracto del post, el link al post
 * original, el mensaje sugerido y el link al detalle del lead en la app.
 *
 * @param lead Lead ya clasificado del que se arma el aviso.
 * @returns El texto del mensaje, listo para {@link import("./evolution").sendWhatsApp}.
 */
export function buildLeadMessage(lead: LeadForMessage): string {
  const blocks: string[] = [];

  // Título en negrita con la fuente real del lead.
  blocks.push(`*🎯 Nuevo lead — ${sourceDisplayName(lead.source)}*`);

  // Categoría y score, los que estén disponibles.
  const meta: string[] = [];
  if (lead.category) meta.push(`📂 ${lead.category}`);
  if (typeof lead.score === "number") meta.push(`⭐ ${Math.round(lead.score)}/100`);
  if (meta.length > 0) blocks.push(meta.join("  ·  "));

  // Extracto del post: título + primeras líneas del cuerpo.
  const post = [lead.title?.trim(), lead.body?.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  if (post) blocks.push(excerpt(post, EXCERPT_MAX_LENGTH));

  // Link al post original (WhatsApp lo vuelve clickeable solo).
  if (lead.url) blocks.push(`🔗 ${lead.url}`);

  // Mensaje sugerido por la IA.
  const reply = lead.suggested_reply?.trim();
  if (reply) blocks.push(`_Respuesta sugerida:_\n${reply}`);

  // Link al detalle del lead en la app.
  blocks.push(`📋 Ver detalle: ${env.APP_URL}/leads/${lead.id}`);

  return blocks.join("\n\n");
}

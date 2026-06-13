import { z } from "zod";

/**
 * Validación del entorno de Lead Detector.
 *
 * Valida `process.env` con Zod al importar el módulo y exporta un objeto `env`
 * tipado. Si falta una variable REQUERIDA, lanza un error que la nombra. Las
 * variables OPCIONALES pueden faltar: si lo hacen, la fuente que dependa de
 * ellas queda inerte, pero la app arranca igual.
 *
 * Pensado para usarse en el servidor (rutas API, cron, scripts) y durante el
 * build. No importar desde componentes de cliente.
 */

/** Formato E.164: `+` seguido de hasta 15 dígitos. Ej. `+5491112345678`. */
const E164 = /^\+[1-9]\d{1,14}$/;

const schema = z.object({
  // --- Supabase: cliente público (se inyecta en el browser) ---
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    error: "NEXT_PUBLIC_SUPABASE_URL debe ser una URL válida",
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string({ error: "Falta NEXT_PUBLIC_SUPABASE_ANON_KEY" })
    .min(1, "NEXT_PUBLIC_SUPABASE_ANON_KEY no puede estar vacía"),

  // --- Secretos de servidor ---
  SUPABASE_SERVICE_ROLE_KEY: z
    .string({ error: "Falta SUPABASE_SERVICE_ROLE_KEY" })
    .min(1, "SUPABASE_SERVICE_ROLE_KEY no puede estar vacía"),
  ANTHROPIC_API_KEY: z
    .string({ error: "Falta ANTHROPIC_API_KEY" })
    .min(1, "ANTHROPIC_API_KEY no puede estar vacía"),
  // Evolution API: la instancia de WhatsApp propia (infra de "senders").
  EVOLUTION_API_URL: z.url({
    error: "EVOLUTION_API_URL debe ser una URL válida",
  }),
  EVOLUTION_API_KEY: z
    .string({ error: "Falta EVOLUTION_API_KEY" })
    .min(1, "EVOLUTION_API_KEY no puede estar vacía"),
  EVOLUTION_INSTANCE: z
    .string({ error: "Falta EVOLUTION_INSTANCE" })
    .min(1, "EVOLUTION_INSTANCE no puede estar vacía"),
  OWNER_WHATSAPP: z
    .string({ error: "Falta OWNER_WHATSAPP" })
    .regex(E164, "OWNER_WHATSAPP debe estar en formato E.164, ej. +5491112345678"),
  CRON_SECRET: z
    .string({ error: "Falta CRON_SECRET" })
    .min(16, "CRON_SECRET debe ser un string aleatorio largo (mín. 16 caracteres)"),
  AUTH_SECRET: z
    .string({ error: "Falta AUTH_SECRET" })
    .min(16, "AUTH_SECRET debe ser un string aleatorio largo (mín. 16 caracteres)"),
  REDDIT_USER_AGENT: z
    .string({ error: "Falta REDDIT_USER_AGENT" })
    .min(1, "REDDIT_USER_AGENT no puede estar vacía"),
  DASHBOARD_PASSWORD: z
    .string({ error: "Falta DASHBOARD_PASSWORD" })
    .min(1, "DASHBOARD_PASSWORD no puede estar vacía"),

  // APP_URL es requerida como valor resuelto, pero puede derivarse de VERCEL_URL
  // (ver `resolveAppUrl`). Por eso ambas se validan acá como opcionales.
  APP_URL: z
    .url({ error: "APP_URL debe ser una URL válida" })
    .optional(),
  VERCEL_URL: z.string().min(1).optional(),

  // --- Opcionales: credenciales de fuentes que requieren setup ---
  // Si faltan, esa fuente queda inerte pero la app arranca sin error.
  FREELANCER_OAUTH_TOKEN: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_API_ID: z.string().min(1).optional(),
  TELEGRAM_API_HASH: z.string().min(1).optional(),
  TELEGRAM_SESSION: z.string().min(1).optional(),
  SCRAPER_API_KEY: z.string().min(1).optional(),

  // --- Autopilot (v2): canales de conversación + webhooks ---
  // Todas opcionales: sin ellas, ese canal queda inerte y la app arranca igual.
  // Protege los webhooks entrantes (`/api/inbound/*`). Sin esto, los webhooks
  // rechazan todo: el outreach automático queda efectivamente apagado.
  WEBHOOK_SECRET: z
    .string()
    .min(16, "WEBHOOK_SECRET debe ser un string aleatorio largo (mín. 16 caracteres)")
    .optional(),
  // URL pública del worker de Telegram en Railway (para mandar y recibir DMs).
  TELEGRAM_WORKER_URL: z
    .url({ error: "TELEGRAM_WORKER_URL debe ser una URL válida" })
    .optional(),
  // Bluesky: identificador (handle o email) + app password (NO la real).
  BLUESKY_IDENTIFIER: z.string().min(1).optional(),
  BLUESKY_APP_PASSWORD: z.string().min(1).optional(),
  // Reddit: credenciales de una "script app" + refresh token (OAuth).
  REDDIT_CLIENT_ID: z.string().min(1).optional(),
  REDDIT_CLIENT_SECRET: z.string().min(1).optional(),
  REDDIT_REFRESH_TOKEN: z.string().min(1).optional(),
});

type RawEnv = z.infer<typeof schema>;

/**
 * Normaliza `process.env`: convierte strings vacías en `undefined` para que
 * `KEY=` (sin valor) se trate igual que una variable ausente.
 */
function readSource(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    out[key] = value === "" ? undefined : value;
  }
  return out;
}

/** Resuelve la URL base del deploy. En Vercel se deriva de `VERCEL_URL`. */
function resolveAppUrl(raw: RawEnv): string {
  if (raw.APP_URL) return raw.APP_URL;
  if (raw.VERCEL_URL) return `https://${raw.VERCEL_URL}`;
  throw new Error(
    "Falta la variable de entorno requerida: APP_URL " +
      "(o VERCEL_URL, para derivarla automáticamente).",
  );
}

const parsed = schema.safeParse(readSource());

if (!parsed.success) {
  const detail = parsed.error.issues
    .map((issue) => `  • ${issue.path.join(".") || "(raíz)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Variables de entorno inválidas o faltantes:\n${detail}\n` +
      "Revisá tu archivo .env.local (ver .env.example).",
  );
}

const raw = parsed.data;

/** Entorno validado y tipado. Las `NEXT_PUBLIC_*` van agrupadas en `NEXT_PUBLIC`. */
export const env = {
  NEXT_PUBLIC: {
    SUPABASE_URL: raw.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: raw.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },

  SUPABASE_SERVICE_ROLE_KEY: raw.SUPABASE_SERVICE_ROLE_KEY,
  ANTHROPIC_API_KEY: raw.ANTHROPIC_API_KEY,
  EVOLUTION_API_URL: raw.EVOLUTION_API_URL,
  EVOLUTION_API_KEY: raw.EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE: raw.EVOLUTION_INSTANCE,
  OWNER_WHATSAPP: raw.OWNER_WHATSAPP,
  CRON_SECRET: raw.CRON_SECRET,
  AUTH_SECRET: raw.AUTH_SECRET,
  REDDIT_USER_AGENT: raw.REDDIT_USER_AGENT,
  DASHBOARD_PASSWORD: raw.DASHBOARD_PASSWORD,
  APP_URL: resolveAppUrl(raw),

  // Opcionales: pueden ser `undefined`.
  FREELANCER_OAUTH_TOKEN: raw.FREELANCER_OAUTH_TOKEN,
  DISCORD_BOT_TOKEN: raw.DISCORD_BOT_TOKEN,
  TELEGRAM_API_ID: raw.TELEGRAM_API_ID,
  TELEGRAM_API_HASH: raw.TELEGRAM_API_HASH,
  TELEGRAM_SESSION: raw.TELEGRAM_SESSION,
  SCRAPER_API_KEY: raw.SCRAPER_API_KEY,

  // Autopilot (v2).
  WEBHOOK_SECRET: raw.WEBHOOK_SECRET,
  TELEGRAM_WORKER_URL: raw.TELEGRAM_WORKER_URL,
  BLUESKY_IDENTIFIER: raw.BLUESKY_IDENTIFIER,
  BLUESKY_APP_PASSWORD: raw.BLUESKY_APP_PASSWORD,
  REDDIT_CLIENT_ID: raw.REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET: raw.REDDIT_CLIENT_SECRET,
  REDDIT_REFRESH_TOKEN: raw.REDDIT_REFRESH_TOKEN,
} as const;

export type Env = typeof env;

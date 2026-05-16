import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

let cached: SupabaseClient | undefined;

/**
 * Devuelve un cliente de Supabase creado con la `SUPABASE_SERVICE_ROLE_KEY`.
 *
 * Este cliente **bypassa RLS**: usarlo sólo en código de servidor de confianza
 * (rutas API, jobs de cron, scripts), nunca expuesto al cliente. El cliente se
 * memoiza para reutilizar la conexión entre invocaciones.
 */
export function getAdminClient(): SupabaseClient {
  if (!cached) {
    cached = createClient(
      env.NEXT_PUBLIC.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }
  return cached;
}

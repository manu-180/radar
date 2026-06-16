/**
 * Configuración del MCP de Freelancer.com.
 *
 * Todo sale de variables de entorno (las inyecta la config del MCP en
 * `~/.claude.json`, o un `.env` en dev). El token NO se valida al bootear: el
 * server arranca igual y, si falta, cada tool devuelve un error claro. Así
 * Claude ve el motivo en vez de que el proceso muera en silencio.
 */

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/** Base de la API (cambiable a freelancer.in vía env). */
export const BASE_URL =
  trimmed(process.env.FREELANCER_API_URL) ?? "https://www.freelancer.com";

/** Token OAuth personal del dueño de la cuenta. Puede faltar (ver módulo). */
export const OAUTH_TOKEN = trimmed(process.env.FREELANCER_OAUTH_TOKEN);

/** `User-Agent` con el que el MCP se identifica ante la API. */
export const USER_AGENT = "FreelancerMCP/1.0 (+claude-code)";

/**
 * Tope de bids por sesión del MCP. Es una barrera anti-bot: postular muchos
 * bids muy rápido es lo que Freelancer banea. Por encima de esto, `place_bid`
 * se niega y el usuario decide a mano. Default conservador: 8.
 */
export const DAILY_BID_CAP = (() => {
  const raw = Number(process.env.FREELANCER_DAILY_BID_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

/**
 * Precios de los modelos de Claude y cálculo del costo de una clasificación.
 *
 * Módulo puro y sin dependencias: aísla todo lo que es "cuánto cuesta una
 * llamada" para que el orquestador de clasificación (`/api/process`) no mezcle
 * tarifas con lógica de cola, y para poder testearlo solo.
 *
 * ## Por qué el desglose de tokens importa
 *
 * El clasificador usa **prompt caching** sobre el system prompt estático. Con
 * caché, los tokens de entrada se reparten en tres baldes con tarifas distintas:
 *
 *  - **uncached** — entrada normal, a la tarifa base del modelo.
 *  - **cache creation** — escribir el bloque a la caché: **1.25×** la tarifa base.
 *  - **cache read** — leer el bloque ya cacheado: **0.10×** la tarifa base.
 *
 * Contar solo los `uncached` (lo que hacía la versión anterior) **subestima** el
 * gasto real: la primera llamada de cada corrida paga el 1.25× de crear la
 * caché, y todas las demás pagan el 0.10× de leerla. {@link costUsd} prorratea
 * los tres baldes con su multiplicador, así `llm_cost_usd` y las métricas
 * reflejan el costo verdadero.
 */

/** Multiplicador de la tarifa de entrada al **escribir** un bloque a la caché. */
const CACHE_WRITE_MULTIPLIER = 1.25;
/** Multiplicador de la tarifa de entrada al **leer** un bloque ya cacheado. */
const CACHE_READ_MULTIPLIER = 0.1;

/**
 * Consumo de tokens de una o varias llamadas a Claude, con el desglose de caché.
 *
 * Los campos de entrada son disjuntos: el total de tokens de entrada de una
 * llamada es la suma de los tres (ver {@link totalInputTokens}).
 */
export interface TokenUsage {
  /** Tokens de entrada facturados a la tarifa base (no servidos por la caché). */
  uncachedInputTokens: number;
  /** Tokens de entrada escritos a la caché (facturados a 1.25× la tarifa base). */
  cacheCreationTokens: number;
  /** Tokens de entrada servidos desde la caché (facturados a 0.10× la tarifa base). */
  cacheReadTokens: number;
  /** Tokens de salida generados. */
  outputTokens: number;
}

/** Tarifa de un modelo, en USD por millón de tokens. */
export interface ModelPrice {
  /** USD por millón de tokens de entrada (tarifa base). */
  input: number;
  /** USD por millón de tokens de salida. */
  output: number;
}

/**
 * Tarifas por modelo, en USD por millón de tokens. Un modelo ausente de este
 * mapa se cobra como `0` (ver {@link costUsd}): preferimos un costo subestimado
 * y visible antes que romper una corrida por una tarifa que falta.
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Haiku 4.5 — el modelo por defecto del clasificador.
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Sonnet 4.6 — al que se escalan los casos ambiguos.
  "claude-sonnet-4-6": { input: 3, output: 15 },
};

/** Un {@link TokenUsage} en cero, base para acumular con {@link addUsage}. */
export function emptyUsage(): TokenUsage {
  return {
    uncachedInputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
}

/** Suma dos consumos de tokens balde a balde. No muta los argumentos. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Total de tokens de entrada: la suma de los tres baldes. */
export function totalInputTokens(usage: TokenUsage): number {
  return (
    usage.uncachedInputTokens +
    usage.cacheCreationTokens +
    usage.cacheReadTokens
  );
}

/**
 * Costo en USD de un consumo de tokens, según el modelo.
 *
 * Cada balde de entrada se prorratea con su multiplicador de caché; la salida
 * va a la tarifa de salida del modelo. Un modelo sin tarifa conocida devuelve
 * `0` en vez de lanzar: el costo queda subestimado pero la corrida no se cae.
 */
export function costUsd(model: string, usage: TokenUsage): number {
  const price = MODEL_PRICING[model];
  if (!price) return 0;

  const inputUnits =
    usage.uncachedInputTokens +
    usage.cacheCreationTokens * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadTokens * CACHE_READ_MULTIPLIER;

  const inputCost = (inputUnits / 1e6) * price.input;
  const outputCost = (usage.outputTokens / 1e6) * price.output;
  return inputCost + outputCost;
}

/** Redondea un costo a 6 decimales, la precisión de la columna `llm_cost_usd`. */
export function roundCost(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

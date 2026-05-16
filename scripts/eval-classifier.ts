/**
 * Evaluación del clasificador de leads contra el set etiquetado.
 *
 * Corré con:  npm run eval   (alias de  npx tsx scripts/eval-classifier.ts)
 *
 * Pasa cada caso de `test/fixtures/classifier-cases.ts` por `classifyLead` y
 * reporta:
 *  - la precisión global (categoría predicha == categoría esperada),
 *  - una matriz de confusión esperada-vs-predicha,
 *  - el detalle de los casos fallados.
 *
 * Es una herramienta MANUAL: se corre al tocar el system prompt o los few-shot
 * del clasificador (paso 13). NO está en `npm test` ni en el CI porque hace
 * llamadas reales a la API de Claude, que cuestan y requieren una
 * `ANTHROPIC_API_KEY` válida.
 *
 * El proceso termina con código de salida 1 si la precisión global cae por
 * debajo del umbral ({@link MIN_ACCURACY}), así sirve como verificación de
 * regresión al ajustar el prompt.
 *
 * --- Re-ejecución ---
 * El clasificador importa `server-only`, que lanza al importarse si no se
 * resuelve con la condición `react-server` (la que aplica Next, no `npx tsx`).
 * Además los scripts sueltos no cargan `.env.local` por su cuenta. Para que
 * `npm run eval` funcione sin flags, en la primera pasada el script se
 * re-ejecuta a sí mismo agregando `--conditions=react-server` y
 * `--env-file=.env.local`. La lógica real corre en ese proceso hijo.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { ClassifyLeadInput, LeadCategory } from "@/lib/ai/classifier";
import type { ClassifierCase } from "@/test/fixtures/classifier-cases";

// --- Re-ejecución: corre antes de cualquier import dinámico del clasificador ---
if (!process.env.__EVAL_CLASSIFIER_CHILD) {
  const flags = ["--conditions=react-server"];
  if (existsSync(".env.local")) flags.push("--env-file=.env.local");

  const child = spawnSync(
    process.execPath,
    [...process.execArgv, ...flags, ...process.argv.slice(1)],
    {
      stdio: "inherit",
      env: { ...process.env, __EVAL_CLASSIFIER_CHILD: "1" },
    },
  );
  process.exit(child.status ?? 1);
}

// --- A partir de acá corremos en el proceso hijo: condición y env ya aplicados ---

/** Umbral de precisión global exigido por el criterio de éxito del paso 14. */
const MIN_ACCURACY = 0.85;

/** Perfil del freelancer (espejo de la fila semilla de `settings`). */
const FREELANCER_PROFILE =
  "Developer freelance. Hace webs y apps a medida con Next.js, React y " +
  "back-ends modernos. Entrega rápida y precios competitivos.";

/** Orden fijo de las categorías, para filas/columnas de la matriz. */
const CATEGORIES: LeadCategory[] = ["hiring", "maybe", "noise"];

/** Resultado de evaluar un caso. */
interface CaseOutcome {
  case: ClassifierCase;
  predicted: LeadCategory;
  score: number;
  reason: string;
}

/** Arma el `ClassifyLeadInput` que espera el clasificador a partir de un caso. */
function toInput(c: ClassifierCase): ClassifyLeadInput {
  return {
    title: c.title,
    body: c.body,
    // El set no modela URLs ni keywords del pre-filtro: son metadatos de
    // apoyo y la evaluación mide la clasificación por el contenido real.
    url: `https://example.test/${c.source}/${c.id}`,
    lang: c.lang,
    source: c.source,
    prefilter_matched: [],
  };
}

/** `true` si el error del SDK es un fallo de autenticación (API key inválida). */
function isAuthError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status?: unknown }).status === 401
  );
}

/** Imprime la matriz de confusión esperada (filas) vs. predicha (columnas). */
function printConfusionMatrix(outcomes: CaseOutcome[]): void {
  // matrix[esperada][predicha] = cantidad de casos.
  const matrix: Record<string, Record<string, number>> = {};
  for (const exp of CATEGORIES) {
    matrix[exp] = {};
    for (const pred of CATEGORIES) matrix[exp][pred] = 0;
  }
  for (const o of outcomes) {
    matrix[o.case.expectedCategory][o.predicted] += 1;
  }

  const col = (s: string): string => s.padStart(8);
  console.log("\nMatriz de confusión (filas = esperada, columnas = predicha):");
  console.log(`  ${"".padEnd(10)}${CATEGORIES.map(col).join("")}${col("total")}`);
  for (const exp of CATEGORIES) {
    const cells = CATEGORIES.map((pred) => col(String(matrix[exp][pred])));
    const total = CATEGORIES.reduce((sum, pred) => sum + matrix[exp][pred], 0);
    console.log(`  ${exp.padEnd(10)}${cells.join("")}${col(String(total))}`);
  }
}

async function main(): Promise<void> {
  const { classifyLead, DEFAULT_CLASSIFIER_MODEL } = await import(
    "@/lib/ai/classifier"
  );
  const { CLASSIFIER_CASES } = await import(
    "@/test/fixtures/classifier-cases"
  );

  console.log(
    `Evaluando ${CLASSIFIER_CASES.length} casos con el modelo ` +
      `${DEFAULT_CLASSIFIER_MODEL}…\n`,
  );

  const outcomes: CaseOutcome[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (const [i, c] of CLASSIFIER_CASES.entries()) {
    const { result, usage } = await classifyLead(toInput(c), {
      model: DEFAULT_CLASSIFIER_MODEL,
      freelancerProfile: FREELANCER_PROFILE,
    });
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;

    const ok = result.category === c.expectedCategory;
    outcomes.push({
      case: c,
      predicted: result.category,
      score: result.score,
      reason: result.reason,
    });
    process.stdout.write(
      `  [${String(i + 1).padStart(2)}/${CLASSIFIER_CASES.length}] ` +
        `${ok ? "✓" : "✗"} ${c.id} ` +
        `→ ${result.category} (esperada: ${c.expectedCategory})\n`,
    );
  }

  const failed = outcomes.filter(
    (o) => o.predicted !== o.case.expectedCategory,
  );
  const correct = outcomes.length - failed.length;
  const accuracy = correct / outcomes.length;

  printConfusionMatrix(outcomes);

  if (failed.length > 0) {
    console.log(`\nCasos fallados (${failed.length}):`);
    for (const o of failed) {
      console.log("─".repeat(68));
      console.log(`  caso     : ${o.case.id}`);
      console.log(`  título   : ${o.case.title}`);
      console.log(
        `  esperada : ${o.case.expectedCategory}  |  predicha : ` +
          `${o.predicted}  (score ${o.score})`,
      );
      console.log(`  reason   : ${o.reason}`);
    }
  }

  console.log("─".repeat(68));
  console.log(
    `\nPrecisión global: ${(accuracy * 100).toFixed(1)}% ` +
      `(${correct}/${outcomes.length} correctos)`,
  );
  console.log(
    `Tokens: ${inputTokens} in, ${outputTokens} out  ` +
      `(umbral exigido: ${(MIN_ACCURACY * 100).toFixed(0)}%)`,
  );

  if (accuracy < MIN_ACCURACY) {
    console.log(
      `\n✗ La precisión está por debajo del umbral del ` +
        `${(MIN_ACCURACY * 100).toFixed(0)}%. Ajustá el system prompt o los ` +
        `few-shot del clasificador (paso 13) y volvé a correr.`,
    );
    process.exit(1);
  }
  console.log("\n✓ La precisión global cumple el umbral exigido.");
}

main().catch((err: unknown) => {
  if (isAuthError(err)) {
    console.error(
      "eval-classifier: la API de Anthropic rechazó la credencial (401).\n" +
        "Poné una ANTHROPIC_API_KEY válida en .env.local y volvé a correr.",
    );
  } else {
    console.error("eval-classifier falló:", err);
  }
  process.exit(1);
});

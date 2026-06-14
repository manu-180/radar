# High-Intent Sources (Freelancer ES) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activar **Freelancer.com como fuente de alta intención en español** (cada post es alguien contratando), agregando un **bypass de pre-filtro por fuente** para que esos leads no se pierdan en el filtro de keywords, y dejándolos caer en el camino "avisar a Manuel por WhatsApp". Investigar después una vía **gratis** para Workana.

**Architecture:** El pipeline existente (`poll → pre-filtro keywords → clasifica Haiku → notify/engage`) descarta items que no matchean las frases exactas de la tabla `keywords`. En un job-board eso tira leads reales. Se agrega una propiedad opcional `skipPrefilter` al `SourceAdapter`: las fuentes que la setean saltean el filtro de keywords y van directo al clasificador (barato, y cada post ya está pre-calificado como "hiring"). Freelancer no expone mensajería usable dentro de ToS → `contact_channel=null` → el lead califica y **notifica al dueño** (comportamiento v1 intacto); Manuel licita a mano.

**Tech Stack:** Next.js 16 (route handlers), TypeScript, Zod, Vitest, Supabase (Postgres + pg_cron), Anthropic SDK (clasificador, sin cambios).

---

## Contexto imprescindible (leer antes de tocar)

- **Fuente de verdad:** `docs/ARCHITECTURE.md` (§2 canales/contacto, §7 fuentes) y `docs/PROGRESS.md`.
- **Reglas del repo:** `AGENTS.md` (Next 16; mirroreá patrones v1), `CLAUDE.md`.
- **Patrón de adapter de fuente:** `lib/sources/types.ts` (interfaz `SourceAdapter`), `lib/sources/index.ts` (registry por side-effect).
- **El adapter de Freelancer YA está completo:** `lib/sources/freelancer.ts` (API oficial gratis, header `freelancer-oauth-v1`, degradación elegante sin token). NO reescribir su lógica de fetch.
- **El pre-filtro:** `lib/filter/prefilter.ts`; se aplica en `app/api/poll/[source]/route.ts:101-128`.
- **Patrón de tests:** `test/prefilter.test.ts` (import dinámico de módulos después de sembrar `process.env`, helper `makeItem`) y `test/http.test.ts` (mock de `fetch` con `vi.stubGlobal`).

### Hechos verificados en la DB en vivo (2026-06-14)
- `sources.freelancer`: `enabled=true`, `config.queries=["website","web app","mobile app","next.js"]`, cursor vacío, **0 leads** (inerte por falta de `FREELANCER_OAUTH_TOKEN`).
- `settings.notify_rule = {minScore:70, categories:["hiring"]}` → un lead `hiring` con score ≥ 70 **se notifica por WhatsApp** aunque no tenga canal de contacto.
- `settings.engage_rule = {minScore:75, categories:["hiring"]}` + `channel_autopilot` no tiene `freelancer` → los leads de Freelancer **no** se auto-enganchan (no hay canal). Correcto.
- `FREELANCER_OAUTH_TOKEN` ya existe como opcional en `lib/env.ts`. No hay que tocar el schema de env.

### ⚠️ Coordinación con la otra sesión (Bluesky)
- Esta rama trabaja en `lib/sources/*`, `lib/filter/*`, `supabase/migrations/*`, `test/*`.
- **El ÚNICO archivo compartido fuera de esos paths es `app/api/poll/[source]/route.ts`** (Tarea 2): cambio mínimo y aditivo (swap de una llamada). Flaguearlo al hacer merge. NO tocar nada de `lib/channels/bluesky.ts` ni `lib/sources/bluesky.ts`.

### Inputs pendientes de Manuel (no bloquean construir/testear; bloquean el end-to-end real)
- `FREELANCER_OAUTH_TOKEN`: token OAuth2 personal de Freelancer.com → cargar en Vercel (Preview + Production).
  - Se obtiene desde el portal de desarrolladores (developers.freelancer.com → app/credenciales) o configuración de cuenta. **El header ya lo manda el adapter** (`freelancer-oauth-v1`).
  - **Riesgo honesto:** Freelancer puede gatear el acceso a la API detrás de una **aprobación**. Si pide aprobación, es un trámite fuera de nuestro control — se sabe recién cuando Manuel intente generar el token. (Verificar la UI actual; puede haber cambiado.)

---

## File Structure

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `lib/sources/types.ts` | Modify | Agregar `skipPrefilter?: boolean` a `SourceAdapter`. |
| `lib/filter/prefilter.ts` | Modify | Agregar `decidePrefilter()` (envuelve `prefilter` con el bypass). |
| `app/api/poll/[source]/route.ts` | Modify | Usar `decidePrefilter(...)` con `adapter.skipPrefilter`. **(archivo compartido)** |
| `lib/sources/freelancer.ts` | Modify | Setear `skipPrefilter: true` en el adapter. |
| `supabase/migrations/0011_freelancer_es.sql` | Create | Reorientar las queries de Freelancer al español. |
| `test/prefilter.test.ts` | Modify | Tests de `decidePrefilter` (bypass on/off). |
| `test/freelancer.test.ts` | Create | Tests del adapter: `skipPrefilter`, inerte sin token, `contact` ausente (modelo notify). |
| `docs/PROGRESS.md` | Modify | Registrar sesión + estado + análisis honesto de Workana/X/IG/Reddit. |

---

## Task 0: Rama de trabajo

**Files:** ninguno (git).

- [ ] **Step 1: Verificar el estado y crear la rama**

```bash
git status                      # árbol limpio salvo CLAUDE.md ya modificado por el entorno
git rev-parse --abbrev-ref HEAD # esperado: feat/autopilot
git checkout -b feat/high-intent-sources
```

Notas: se ramifica desde el HEAD actual (refleja lo que está vivo en prod). Cambios aditivos; el merge a `main` se coordina con Manuel y la sesión de Bluesky. **No** pushear a `main`.

---

## Task 1: Bypass de pre-filtro por fuente (`skipPrefilter` + `decidePrefilter`)

**Files:**
- Modify: `lib/sources/types.ts`
- Modify: `lib/filter/prefilter.ts`
- Test: `test/prefilter.test.ts`

- [ ] **Step 1: Escribir los tests que fallan** (agregar al final de `test/prefilter.test.ts`, dentro del archivo existente; reusa `importPrefilter`, `KEYWORDS`, `makeItem`)

```ts
describe("decidePrefilter", () => {
  it("con skipPrefilter=true, un item de job-board pasa aunque no matchee ninguna keyword", async () => {
    const { decidePrefilter } = await importPrefilter();
    const result = decidePrefilter(
      makeItem({
        title: "Desarrollo de tienda online en Shopify",
        body: "Presupuesto a convenir, urgente",
      }),
      "es",
      KEYWORDS,
      true,
    );
    expect(result.passed).toBe(true);
    expect(result.matched).toEqual([]);
    expect(result.reason).toMatch(/alta intenci/i);
  });

  it("con skipPrefilter=false, delega en el pre-filtro normal y descarta lo que no matchea", async () => {
    const { decidePrefilter } = await importPrefilter();
    const result = decidePrefilter(
      makeItem({ title: "Vendo bicicleta usada en buen estado" }),
      "es",
      KEYWORDS,
      false,
    );
    expect(result.passed).toBe(false);
    expect(result.matched).toEqual([]);
  });

  it("con skipPrefilter=false, deja pasar un pedido real igual que prefilter", async () => {
    const { decidePrefilter } = await importPrefilter();
    const result = decidePrefilter(
      makeItem({ title: "Necesito un desarrollador para mi web" }),
      "es",
      KEYWORDS,
      false,
    );
    expect(result.passed).toBe(true);
    expect(result.matched).toContain("necesito un desarrollador");
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/prefilter.test.ts`
Expected: FAIL — `decidePrefilter` no existe / no es export de `lib/filter/prefilter`.

- [ ] **Step 3: Agregar `skipPrefilter` a la interfaz `SourceAdapter`**

En `lib/sources/types.ts`, dentro de `interface SourceAdapter`, después de `displayName`:

```ts
  /**
   * Si la fuente saltea el pre-filtro de keywords. `true` para fuentes de alta
   * intención (job-boards: Freelancer, Workana, …) donde cada item es, por
   * definición, alguien que quiere contratar: el filtro de keywords —pensado
   * para cortar el ruido de fuentes sociales— sólo tiraría leads reales cuyo
   * wording no matchea las frases exactas. Esos items pasan siempre y el
   * clasificador (barato) juzga el fit. Default (ausente) = aplica el filtro.
   */
  skipPrefilter?: boolean;
```

- [ ] **Step 4: Implementar `decidePrefilter`** (agregar al final de `lib/filter/prefilter.ts`)

```ts
/**
 * Decide si un item avanza a la clasificación, contemplando el bypass por fuente.
 *
 * Envuelve a {@link prefilter}: si la fuente declara `skipPrefilter`, el item
 * pasa siempre (sin mirar keywords) porque ya es un pedido de contratación
 * explícito; si no, delega en el pre-filtro de keywords normal.
 *
 * @param item           Item crudo de la fuente.
 * @param lang           Idioma detectado del item.
 * @param keywords       Keywords habilitadas (ver {@link loadKeywords}).
 * @param skipPrefilter  `true` si la fuente saltea el filtro de keywords.
 */
export function decidePrefilter(
  item: RawItem,
  lang: string,
  keywords: Keyword[],
  skipPrefilter: boolean,
): PrefilterResult {
  if (skipPrefilter) {
    return {
      passed: true,
      matched: [],
      reason: "Fuente de alta intención: se saltea el pre-filtro de keywords",
    };
  }
  return prefilter(item, lang, keywords);
}
```

- [ ] **Step 5: Correr los tests y verificar que pasan**

Run: `npx vitest run test/prefilter.test.ts`
Expected: PASS (los nuevos + los 9 existentes de `prefilter`).

- [ ] **Step 6: Commit**

```bash
git add lib/sources/types.ts lib/filter/prefilter.ts test/prefilter.test.ts
git commit -m "feat(sources): bypass de pre-filtro por fuente para job-boards de alta intención"
```

---

## Task 2: Cablear el poll route al bypass (archivo compartido — flaguear)

**Files:**
- Modify: `app/api/poll/[source]/route.ts`

- [ ] **Step 1: Cambiar el import**

En `app/api/poll/[source]/route.ts`, línea ~17:

```ts
// antes
import { loadKeywords, prefilter } from "@/lib/filter/prefilter";
// después
import { loadKeywords, decidePrefilter } from "@/lib/filter/prefilter";
```

- [ ] **Step 2: Usar `decidePrefilter` con la propiedad del adapter**

En el `.map(...)` (línea ~103), reemplazar:

```ts
// antes
const result = prefilter(item, lang, keywords);
// después
const result = decidePrefilter(item, lang, keywords, adapter.skipPrefilter ?? false);
```

(`adapter` ya está en scope: viene de `getSource(slug)` en la línea ~71. El resto del map queda igual: `queueStatus`, `prefilter_matched: result.matched`, etc.)

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck && npx vitest run`
Expected: PASS, sin errores de tipo.

- [ ] **Step 4: Commit**

```bash
git add app/api/poll/[source]/route.ts
git commit -m "feat(poll): respetar skipPrefilter del adapter en la corrida de polling"
```

> **Coordinación:** este es el único archivo fuera de `lib/sources|filter`. Cambio aditivo de 2 líneas. Al mergear, si la sesión de Bluesky tocó este archivo, resolver a favor de mantener ambos cambios (son independientes).

---

## Task 3: Activar `skipPrefilter` en el adapter de Freelancer + tests

**Files:**
- Modify: `lib/sources/freelancer.ts`
- Test: `test/freelancer.test.ts` (create)

- [ ] **Step 1: Escribir los tests que fallan** (`test/freelancer.test.ts`)

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

/** Set mínimo de env para que `lib/env` valide (igual que test/prefilter.test.ts). */
const BASE: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  ANTHROPIC_API_KEY: "sk-ant-test",
  EVOLUTION_API_URL: "https://evolution.example.com",
  EVOLUTION_API_KEY: "evolution-key",
  EVOLUTION_INSTANCE: "wa-test",
  OWNER_WHATSAPP: "+5491112345678",
  CRON_SECRET: "cron-secret-aleatorio-largo-1234",
  AUTH_SECRET: "auth-secret-aleatorio-largo-1234",
  REDDIT_USER_AGENT: "lead-detector/1.0",
  DASHBOARD_PASSWORD: "dashboard-password",
  APP_URL: "http://localhost:3000",
};

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Carga el adapter con un env válido y, opcionalmente, un token de Freelancer. */
function importFreelancer(extra: Record<string, string> = {}) {
  process.env = { ...BASE, ...extra } as NodeJS.ProcessEnv;
  vi.resetModules();
  return import("../lib/sources/freelancer");
}

describe("freelancerAdapter", () => {
  it("declara skipPrefilter=true (fuente de alta intención)", async () => {
    const { freelancerAdapter } = await importFreelancer();
    expect(freelancerAdapter.skipPrefilter).toBe(true);
  });

  it("sin token queda inerte: devuelve items vacíos sin lanzar", async () => {
    const { freelancerAdapter } = await importFreelancer(); // sin FREELANCER_OAUTH_TOKEN
    const out = await freelancerAdapter.fetchItems({ queries: ["página web"] }, {});
    expect(out.items).toEqual([]);
  });

  it("con token, mapea proyectos a RawItem sin datos de contacto (modelo notify)", async () => {
    const project = {
      id: 123,
      owner_id: 9,
      title: "Necesito una página web para mi pyme",
      description: "Quiero una landing que convierta. Presupuesto a convenir.",
      seo_url: "necesito-pagina-web",
      submitdate: Math.floor(Date.now() / 1000),
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ status: "success", result: { projects: [project] } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { freelancerAdapter } = await importFreelancer({
      FREELANCER_OAUTH_TOKEN: "tok-test",
    });
    const out = await freelancerAdapter.fetchItems({ queries: ["página web"] }, {});

    expect(out.items).toHaveLength(1);
    expect(out.items[0].title).toContain("página web");
    // Freelancer no es contactable dentro de ToS → sin `contact` → cae en notify.
    expect(out.items[0].contact ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run test/freelancer.test.ts`
Expected: FAIL en el caso `skipPrefilter` (la propiedad todavía no existe en el adapter).

- [ ] **Step 3: Setear `skipPrefilter` en el adapter**

En `lib/sources/freelancer.ts`, en el objeto `freelancerAdapter`, después de `configSchema,`:

```ts
  // Cada proyecto activo es, por definición, alguien que quiere contratar: no
  // pasa por el filtro de keywords (lo juzga el clasificador). Ver types.ts.
  skipPrefilter: true,
```

- [ ] **Step 4: Correr los tests y verificar que pasan**

Run: `npx vitest run test/freelancer.test.ts`
Expected: PASS (los 3 casos).

- [ ] **Step 5: Commit**

```bash
git add lib/sources/freelancer.ts test/freelancer.test.ts
git commit -m "feat(freelancer): activar skipPrefilter y cubrir el modelo notify con tests"
```

---

## Task 4: Migración — reorientar Freelancer al español

**Files:**
- Create: `supabase/migrations/0011_freelancer_es.sql`

- [ ] **Step 1: Escribir la migración** (idempotente, forward-only; mismo estilo que `0010_web_targeting.sql`)

```sql
-- 0011_freelancer_es.sql
-- Decisión: español-only (Manuel no opera en inglés todavía). Reorienta la fuente
-- Freelancer.com del set genérico en inglés a términos de intención "web" en
-- español, para pescar proyectos del mercado AR/LatAm/España.
--
-- Idempotente: setea el config completo de la fila `freelancer` (re-correr da el
-- mismo resultado). Aditiva: no toca otras fuentes. La fuente queda `enabled`
-- pero permanece inerte hasta que se cargue FREELANCER_OAUTH_TOKEN en Vercel.

update sources
set config = '{"queries": ["página web", "sitio web", "tienda online", "aplicación web", "landing page", "desarrollo web", "diseño web", "ecommerce"]}'::jsonb,
    enabled = true
where slug = 'freelancer';
```

- [ ] **Step 2: Validar el SQL localmente** (sin aplicar): revisar que el JSON sea válido y el `where` apunte sólo a `freelancer`. No se aplica todavía (se aplica en Task 6, contra la DB, vía MCP `supabase-radar`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0011_freelancer_es.sql
git commit -m "feat(db): migración 0011 — queries de Freelancer en español"
```

---

## Task 5: Verificación completa + preview

**Files:** ninguno (CI local + deploy).

- [ ] **Step 1: Suite verde de punta a punta**

Run: `npm run lint && npm run typecheck && npx vitest run && npm run build`
Expected: los 4 PASS. (`build` necesita env dummy local; ver nota de `PROGRESS.md` "Build note".)

- [ ] **Step 2: Push de la rama + preview de Vercel**

```bash
git push -u origin feat/high-intent-sources
```

Vercel crea un deploy de **preview** automático para la rama. Confirmar que buildeó (dashboard de Vercel o MCP). **No** tocar producción.

- [ ] **Step 3: Checkpoint para Manuel**

El preview corre sin el token → Freelancer sigue inerte (0 items), lo cual es correcto y no rompe nada. El end-to-end real se verifica en Task 6 con el token.

---

## Task 6: Activación real (requiere inputs de Manuel)

**Files:** ninguno (DB + env de Vercel).

- [ ] **Step 1: Manuel genera `FREELANCER_OAUTH_TOKEN`** en Freelancer.com (developers portal). Si pide aprobación de API, esperar a que la otorguen.

- [ ] **Step 2: Cargar el token en Vercel** (Preview + Production) como `FREELANCER_OAUTH_TOKEN`. Redeploy.

- [ ] **Step 3: Aplicar la migración 0011 a la DB del radar** (vía MCP `supabase-radar`, `apply_migration` o `execute_sql` con el contenido de `0011_freelancer_es.sql`). Verificar:

```sql
select slug, enabled, config from sources where slug = 'freelancer';
```

Expected: `config.queries` en español, `enabled=true`.

- [ ] **Step 4: Disparar un poll manual y verificar la cadena** (con el token ya cargado):

```sql
-- después de la próxima corrida de cron (o un POST manual a /api/poll/freelancer con x-cron-secret)
select count(*) as nuevos,
       count(*) filter (where llm_status='pending') as a_clasificar,
       count(*) filter (where category='hiring') as hiring
from leads where source='freelancer';
```

Expected: `nuevos > 0`, `a_clasificar > 0` (bypass funcionando: no quedan en `skipped`), y tras el `process`, algunos `hiring` → que disparan `notify` al WhatsApp de Manuel.

- [ ] **Step 5: Confirmar la notificación** llega al WhatsApp del dueño con título + URL del proyecto + `suggested_reply` (borrador de propuesta para licitar a mano en Freelancer).

---

## Task 7: (Fase 2) Investigación — Workana vía vía gratis

**Files:** ninguno todavía (research + decisión).

- [ ] **Step 1: Investigar si Workana expone un feed gratis** que esquive ScraperAPI + Cloudflare:
  - Probar `https://www.workana.com/jobs?...&format=rss` u otras rutas de RSS/Atom/JSON.
  - Probar el endpoint que usa su front (Network tab) por si hay un JSON público.
  - Verificar si esos endpoints responden desde IP de datacenter (Vercel) sin Cloudflare-challenge.
- [ ] **Step 2: Documentar el hallazgo** en `PROGRESS.md`:
  - Si hay feed gratis → plan de adapter nuevo (o ajustar el existente para no depender de `SCRAPER_API_KEY`).
  - Si NO hay → traer a Manuel la decisión de presupuesto (~US$40/mes ScraperAPI) con números, **sin** activar nada.
- [ ] **Step 3: NO implementar Workana en esta sesión** salvo que (a) exista vía gratis y (b) entre en el presupuesto de contexto. Si no, queda como próximo paso documentado.

---

## Task 8: Actualizar PROGRESS.md

**Files:**
- Modify: `docs/PROGRESS.md`

- [ ] **Step 1: Agregar una sección de sesión** con:
  - Qué se hizo: bypass `skipPrefilter` + Freelancer-ES activado (notify model) + migración 0011.
  - Decisión **español-only** (Manuel no opera en inglés; APEX es producto AR/LatAm). Inglés = Fase futura (DolarApp/Wise USD + pricing USD + bot ghostwriting en canales automáticos).
  - **Análisis honesto del objetivo 2 (canal de volumen):**
    - Reddit: **dropeado** en español (r/forhire es ~95% inglés; el source usa `.json` sin auth, bloqueado desde Vercel → necesitaría upgrade a OAuth). Reactivable si se va a inglés.
    - X/Twitter: **no recomendado** — API US$100+/mes, free tier sin search.
    - Instagram: **no recomendado** — sin API de búsqueda, anti-scraping agresivo, ToS.
    - Telegram grupos AR: **candidato fuerte futuro** — gratis, alta intención, canal automático (el bot cierra 100% en español); requiere verificar el worker MTProto.
  - Estado de Workana (según Task 7).
  - Inputs pendientes de Manuel (token Freelancer; aprobación de API si aplica).

- [ ] **Step 2: Commit**

```bash
git add docs/PROGRESS.md
git commit -m "docs(progress): Freelancer-ES activado + bypass de pre-filtro + análisis de canales"
```

---

## Notas de diseño / decisiones (no re-litigar)

- **Bypass, no más keywords:** se eligió `skipPrefilter` por fuente en vez de inflar la tabla `keywords` con frases de job-board (frágil, incompleto, y contaminaría el filtro de las fuentes sociales). El clasificador Haiku es el filtro correcto para items ya pre-calificados como "hiring". Costo: despreciable (volumen modesto, con prompt caching).
- **Modelo de contacto = notify:** Freelancer no tiene mensajería usable dentro de ToS; **auto-bid viola ToS y banea**. Los leads caen en `contact_channel=null` → notifican a Manuel, que licita a mano con el `suggested_reply` como borrador. RESULTADOS > pureza.
- **español-only:** decisión de mercado de Manuel. Re-rankea las fuentes (Freelancer gratis es más finito; Workana es el verdadero caudal español pero pago/frágil).
- **No tocar Bluesky** (otra sesión). Único archivo compartido: el poll route (Task 2), cambio aditivo.

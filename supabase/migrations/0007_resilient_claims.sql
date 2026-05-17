-- ===== 0007 — Reclamos resilientes: leads colgados + regla de notificación =====
--
-- Esta migración cierra dos huecos de los reclamos de cola `claim_pending_leads`
-- y `claim_leads_to_notify` (migraciones 0002 y 0003):
--
-- 1. LEADS COLGADOS. Reclamar un lote lo marca 'processing' / 'sending'. Si la
--    ruta que lo procesa muere de golpe —timeout de la función serverless, OOM,
--    un deploy en el medio— esos leads quedan en ese estado intermedio PARA
--    SIEMPRE: el reclamo sólo miraba filas 'pending', así que nunca los volvía
--    a tomar; y el health-check, que mide el backlog por 'pending', ni siquiera
--    los veía. Se agrega la columna `claimed_at` y los reclamos pasan a
--    re-tomar también las filas 'processing'/'sending' cuyo `claimed_at` quedó
--    más viejo que el umbral de reclamo (15 min). Ese umbral está holgadamente
--    por encima del `maxDuration` de 5 min de las rutas: una corrida sana en
--    curso nunca pierde su lote.
--
-- 2. REGLA DE NOTIFICACIÓN INCONSISTENTE. `claim_leads_to_notify` calificaba un
--    lead con `category = any(cats) OR score >= min_score`. La regla real
--    —documentada, y la que aplica `/api/process` al cerrar la cola de
--    notificación— es Y, no O: un lead califica si su categoría está en la
--    lista Y su score supera el mínimo. Se corrige el OR por AND para que las
--    dos etapas usen exactamente el mismo criterio.
--
-- IDEMPOTENTE: `add column if not exists`, `create index if not exists` y
-- `create or replace function`. Se puede re-correr sin romper nada.

-- ── 1. Marca temporal del reclamo ───────────────────────────────────────────
alter table leads add column if not exists claimed_at timestamptz;

-- Backfill: a cualquier lead que YA esté colgado en un estado intermedio (de
-- antes de esta migración, con `claimed_at` nulo) se le sella `claimed_at` ahora
-- para que el umbral de reclamo lo alcance y se re-procese solo en una corrida
-- siguiente, en vez de quedar perdido.
update leads set claimed_at = now()
where claimed_at is null
  and (llm_status = 'processing' or notify_status = 'sending');

-- Índices parciales: el barrido de filas colgadas queda en O(filas colgadas),
-- no en O(toda la tabla `leads`). Las filas en un estado intermedio son pocas
-- (acotadas por la concurrencia de las rutas), así que estos índices son chicos.
create index if not exists leads_processing_idx
  on leads (claimed_at) where llm_status = 'processing';
create index if not exists leads_sending_idx
  on leads (claimed_at) where notify_status = 'sending';

-- ── 2. claim_pending_leads — reclama 'pending' + 'processing' colgados ──────
-- Igual que la 0002, pero el lote ahora incluye también las filas 'processing'
-- abandonadas (`claimed_at` viejo o nulo). `FOR UPDATE SKIP LOCKED` sigue
-- garantizando que dos corridas solapadas nunca tomen el mismo lead.
create or replace function claim_pending_leads(batch_size int)
returns setof leads language sql as $$
  update leads set llm_status = 'processing', claimed_at = now()
  where id in (
    select id from leads
    where llm_status = 'pending'
       or (llm_status = 'processing'
           and (claimed_at is null
                or claimed_at < now() - interval '15 minutes'))
    order by first_seen_at limit batch_size
    for update skip locked
  )
  returning *;
$$;

-- ── 3. claim_leads_to_notify — 'sending' colgados + regla Y (no O) ──────────
-- Igual que la 0003, con dos cambios: reclama también las filas 'sending'
-- abandonadas, y la regla de calificación pasa de `OR` a `AND` (la categoría
-- debe estar en `cats` Y el score alcanzar `min_score`).
create or replace function claim_leads_to_notify(batch_size int, cats text[], min_score int)
returns setof leads language sql as $$
  update leads set notify_status = 'sending', claimed_at = now()
  where id in (
    select id from leads
    where llm_status = 'done'
      and (
        notify_status = 'pending'
        or (notify_status = 'sending'
            and (claimed_at is null
                 or claimed_at < now() - interval '15 minutes'))
      )
      and category = any(cats)
      and score >= min_score
    order by first_seen_at limit batch_size
    for update skip locked
  )
  returning *;
$$;

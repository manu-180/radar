-- ===== claim_pending_leads =====
-- Reclama un lote de leads pendientes para clasificarlos, marcándolos
-- 'processing' de forma atómica.
--
-- `FOR UPDATE SKIP LOCKED` es lo que hace seguro el reclamo: si dos corridas
-- de `/api/process` se solapan, cada una saltea las filas que la otra ya tomó,
-- así que ningún lead se clasifica dos veces ni hace falta un lock global.
-- Se ordena por `first_seen_at` para drenar el backlog en orden de llegada.
create or replace function claim_pending_leads(batch_size int)
returns setof leads language sql as $$
  update leads set llm_status = 'processing'
  where id in (
    select id from leads where llm_status = 'pending'
    order by first_seen_at limit batch_size
    for update skip locked
  )
  returning *;
$$;

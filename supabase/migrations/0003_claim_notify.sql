-- ===== claim_leads_to_notify =====
-- Reclama un lote de leads ya clasificados que ameritan una notificación,
-- marcándolos 'sending' de forma atómica.
--
-- Igual que `claim_pending_leads`, el `FOR UPDATE SKIP LOCKED` es lo que hace
-- seguro el reclamo: si dos corridas de `/api/notify` se solapan, cada una
-- saltea las filas que la otra ya tomó, así que ningún lead se notifica dos
-- veces. El pasaje de `notify_status` 'pending' -> 'sending' es la marca que
-- impide el doble envío.
--
-- Un lead califica si ya fue clasificado (`llm_status = 'done'`), sigue
-- pendiente de notificar (`notify_status = 'pending'`) y matchea la regla
-- configurada: pertenece a una de las categorías `cats` o supera `min_score`.
-- Se ordena por `first_seen_at` para avisar los leads en orden de llegada.
create or replace function claim_leads_to_notify(batch_size int, cats text[], min_score int)
returns setof leads language sql as $$
  update leads set notify_status = 'sending'
  where id in (
    select id from leads
    where llm_status = 'done' and notify_status = 'pending'
      and (category = any(cats) or score >= min_score)
    order by first_seen_at limit batch_size
    for update skip locked
  )
  returning *;
$$;

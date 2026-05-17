-- ===== 0008 — notifications.wassenger_id → provider_message_id =====
--
-- El sistema dejó de usar Wassenger: los avisos de WhatsApp salen ahora por
-- Evolution API (la instancia propia del dueño, la misma infraestructura de
-- "senders" del proyecto agente-busca-clientes). La columna que guarda el id
-- del mensaje en el proveedor se llamaba `wassenger_id` — un nombre atado a un
-- proveedor que ya no se usa. Se renombra a `provider_message_id`, neutral al
-- proveedor, para que el nombre no mienta sobre lo que guarda.
--
-- Idempotente: el rename sólo corre si la columna vieja todavía existe, así que
-- el script se puede re-correr sin romper nada.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notifications'
      and column_name = 'wassenger_id'
  ) then
    alter table notifications rename column wassenger_id to provider_message_id;
  end if;
end $$;

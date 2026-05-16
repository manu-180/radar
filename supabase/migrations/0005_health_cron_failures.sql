-- ===== health_cron_failures =====
-- Expone al health-check los fallos recientes de pg_cron.
--
-- Por qué un RPC y no una consulta directa: la tabla `cron.job_run_details`
-- vive en el esquema `cron`, que PostgREST no publica — el cliente de la app
-- (service role, vía PostgREST) no puede leerla. Esta función SECURITY DEFINER
-- corre con los privilegios de su dueño (postgres, con acceso al esquema
-- `cron`) y devuelve sólo lo que el monitoreo necesita: las corridas de los
-- jobs `lead-detector-*` que terminaron en `failed` dentro de una ventana.
--
-- El cron dispara cada etapa con `select net.http_post(...)`. Si esa sentencia
-- falla —por ejemplo, no se pudo resolver el secreto del Vault o pg_net está
-- caído— la corrida queda registrada como `failed` acá. Es la única señal del
-- cron que la app puede leer: el cron, por definición, no llega a la app.
create or replace function public.health_cron_failures(since_minutes integer default 90)
returns table (
  jobname        text,
  status         text,
  return_message text,
  start_time     timestamptz
)
language sql
security definer
-- search_path vacío: todo se referencia con esquema explícito, así la función
-- no es vulnerable a un search_path manipulado por el llamador.
set search_path = ''
as $$
  select j.jobname, d.status, d.return_message, d.start_time
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname like 'lead-detector-%'
    and d.status = 'failed'
    and d.start_time > now() - make_interval(mins => since_minutes)
  order by d.start_time desc;
$$;

-- Sólo el service role (el cliente server-side de la app) puede invocarla;
-- una función SECURITY DEFINER no debe quedar expuesta a `anon`/`authenticated`.
revoke all on function public.health_cron_failures(integer) from public;
grant execute on function public.health_cron_failures(integer) to service_role;

-- ============================================================================
-- supabase/cron.sql — Scheduler autónomo del Lead Detector
-- ============================================================================
-- Define los jobs de pg_cron que hacen correr el sistema solo, sin intervención
-- humana. Cada job dispara, vía pg_net, un POST a una ruta `/api/...` de la app.
--
-- Por qué pg_cron y no Vercel Cron: el cron del plan Hobby de Vercel solo
-- permite frecuencia diaria — inservible para sondear cada 20 min. pg_cron corre
-- dentro de Postgres, soporta frecuencia sub-minuto y es gratis.
--
-- Las rutas `/api/...` están protegidas con el header `x-cron-secret`; su valor
-- se lee en cada corrida desde Supabase Vault (secreto `cron_secret`), así nunca
-- queda escrito en texto plano en `cron.job.command`.
--
-- IDEMPOTENTE: primero desagenda los jobs por nombre (los que existan) y después
-- los vuelve a agendar. Se puede re-correr cuantas veces se quiera sin
-- duplicarlos ni romper.
--
-- Etapas desacopladas: si una falla, las otras siguen; cada ruta es idempotente.
-- Los offsets (poll en :00, process en :05, notify en :12) le dan a cada etapa
-- tiempo de adelantarle trabajo a la siguiente.
--
-- URL base: la variable `app_url` de abajo. En el paso 33 (deploy) este script
-- se re-corre cambiando `app_url` por la URL de producción de Vercel.
--
-- Requiere las extensiones pg_cron y pg_net (migración 0004_cron_extensions).
-- Aplicar con el MCP de Supabase (execute_sql).
-- ============================================================================

do $$
declare
  -- URL base de la app. Cambiar por la URL de producción en el paso 33 (deploy).
  app_url text := 'http://localhost:3000';

  -- Plantilla del comando de cada job: un POST cuyo header `x-cron-secret` se
  -- resuelve en tiempo de ejecución desde el Vault — nunca se persiste en la
  -- tabla `cron.job`. El `%L` lo reemplaza `format()` por la URL completa.
  cmd_template constant text := $cmd$
    select net.http_post(
      url     := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'cron_secret'
        )
      )
    );
  $cmd$;
begin
  -- 1) Idempotencia: desagendar los jobs previos que existan. Filtrar por
  --    `cron.job` evita el error de `cron.unschedule` sobre un job inexistente.
  perform cron.unschedule(jobid)
  from cron.job
  where jobname in (
    'lead-detector-poll',
    'lead-detector-process',
    'lead-detector-notify',
    'lead-detector-health'
  );

  -- 2) Polling — minutos :00, :20, :40. Dispara el dispatcher, que abre una
  --    corrida de poll por cada fuente habilitada.
  perform cron.schedule(
    'lead-detector-poll',
    '*/20 * * * *',
    format(cmd_template, app_url || '/api/cron/dispatch')
  );

  -- 3) Clasificación — minutos :05, :25, :45. Drena la cola de leads `pending`
  --    y los clasifica con IA.
  perform cron.schedule(
    'lead-detector-process',
    '5-59/20 * * * *',
    format(cmd_template, app_url || '/api/process')
  );

  -- 4) Notificación — minutos :12, :32, :52. Avisa por WhatsApp los leads ya
  --    clasificados que ameritan un aviso.
  perform cron.schedule(
    'lead-detector-notify',
    '12-59/20 * * * *',
    format(cmd_template, app_url || '/api/notify')
  );

  -- 5) Health-check — minuto :30 de cada hora. El "monitoreo del monitor":
  --    evalúa polling, fuentes, backlog de IA, notificaciones y el propio cron,
  --    y avisa por WhatsApp si algo está roto. Frecuencia horaria —no cada
  --    20 min— porque su anti-spam ya regula los avisos y una falla no necesita
  --    detectarse antes.
  perform cron.schedule(
    'lead-detector-health',
    '30 * * * *',
    format(cmd_template, app_url || '/api/health/check')
  );
end $$;

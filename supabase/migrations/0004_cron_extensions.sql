-- ===== Extensiones para el scheduling autónomo =====
-- El sistema corre solo: un cron dispara las etapas de polling, clasificación
-- y notificación cada 20 min. El cron del plan Hobby de Vercel solo permite
-- frecuencia diaria, así que el scheduler vive dentro de Postgres.
--
--  - `pg_cron` — job scheduler dentro de Postgres; soporta frecuencia sub-minuto.
--  - `pg_net`  — cliente HTTP asíncrono; cada job dispara un `net.http_post`
--                contra una ruta `/api/...` de la app.
--
-- Los jobs en sí se definen en `supabase/cron.sql` (script idempotente, aparte).
create extension if not exists pg_cron;
create extension if not exists pg_net;

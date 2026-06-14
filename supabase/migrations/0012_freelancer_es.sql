-- 0012_freelancer_es.sql (numerado 0012 para no colisionar con 0011_firehose_detection
-- de la sesión de Bluesky; ambas migraciones son independientes)
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

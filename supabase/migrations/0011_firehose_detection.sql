-- 0011_firehose_detection.sql
--
-- Prepara la detección por FIREHOSE de Bluesky (worker persistente que consume
-- el Jetstream) + el tope de costo de la IA. NO toca el esquema: sólo siembra
-- datos (keywords + settings). Forward-only e idempotente: re-correrla deja el
-- mismo estado (los inserts se guardan con guardas de existencia).
--
-- Contexto: con el firehose, el pre-filtro determinístico pasa a ser el cerebro
-- de la detección (corre sobre TODO el stream, no sobre búsquedas). Las capas:
--   1) idioma (franc): el worker descarta lo que detecta como inglés; conserva
--      español + indeterminado (posts cortos), que la Capa 2 filtra.
--   2) keywords (esto): RED ANCHA de intención en español. Se taggean 'any'
--      (no 'es') a propósito: así también matchean los posts que franc no pudo
--      clasificar como 'es' por ser muy cortos. Son frases multi-palabra para
--      no generar falsos positivos por substring (evitar 'app' suelto, etc.).
--   3) (embeddings) — diferida, no se implementa ahora.
--   4) IA (Haiku→Sonnet) — único paso pago, gateado por el presupuesto de abajo.
--
-- NO se desactiva el search-poll de Bluesky acá: queda corriendo en paralelo
-- (dedup por content_hash evita doble proceso) para no abrir un hueco de
-- detección. Se apaga manualmente cuando el worker del firehose esté verificado
-- en vivo (update sources set enabled=false where slug='bluesky').

-- ===== Capa 2: vocabulario de intención (español, ancho, lang 'any') =====
-- El matcher normaliza el término (minúsculas, sin acentos/ñ), así que se
-- guardan en su forma natural y legible; el matcheo es insensible a acentos.
insert into keywords (term, kind, lang)
select v.term, v.kind, v.lang
from (values
  -- Includes: alguien que quiere CONTRATAR para que le hagan algo.
  ('necesito una página',            'include', 'any'),
  ('necesito una página web',        'include', 'any'),
  ('necesito un sitio web',          'include', 'any'),
  ('necesito una web',               'include', 'any'),
  ('necesito una landing',           'include', 'any'),
  ('necesito una tienda online',     'include', 'any'),
  ('necesito un e-commerce',         'include', 'any'),
  ('necesito una app',               'include', 'any'),
  ('necesito una aplicación',        'include', 'any'),
  ('necesito un sistema',            'include', 'any'),
  ('necesito una plataforma',        'include', 'any'),
  ('necesito un desarrollador',      'include', 'any'),
  ('necesito un programador',        'include', 'any'),
  ('necesito quien me haga',         'include', 'any'),
  ('preciso una página web',         'include', 'any'),
  ('quiero una página web',          'include', 'any'),
  ('quiero una web',                 'include', 'any'),
  ('quiero una tienda online',       'include', 'any'),
  ('quiero una app',                 'include', 'any'),
  ('quiero hacer una página',        'include', 'any'),
  ('quiero hacer una web',           'include', 'any'),
  ('quiero crear una página',        'include', 'any'),
  ('busco desarrollador',            'include', 'any'),
  ('busco programador',              'include', 'any'),
  ('busco diseñador web',            'include', 'any'),
  ('busco quien me haga',            'include', 'any'),
  ('busco a alguien que me haga',    'include', 'any'),
  ('estoy buscando un desarrollador','include', 'any'),
  ('ando buscando un programador',   'include', 'any'),
  ('alguien que me haga una página', 'include', 'any'),
  ('alguien que me haga una web',    'include', 'any'),
  ('alguien que me haga un sitio',   'include', 'any'),
  ('alguien que me arme una web',    'include', 'any'),
  ('alguien que me arme una página', 'include', 'any'),
  ('alguien que me diseñe una web',  'include', 'any'),
  ('alguien que haga páginas web',   'include', 'any'),
  ('quién me hace una página',       'include', 'any'),
  ('quién me puede hacer una web',   'include', 'any'),
  ('me hacen una página web',        'include', 'any'),
  ('recomiendan a alguien que haga', 'include', 'any'),
  -- Excludes: autopromoción / búsqueda laboral / oferta de empleo. Conservador
  -- (la IA es el filtro fino de precisión): sólo señales claras de NO-comprador.
  ('me ofrezco',                     'exclude', 'any'),
  ('ofrezco mis servicios',          'exclude', 'any'),
  ('soy desarrollador',              'exclude', 'any'),
  ('soy programador',                'exclude', 'any'),
  ('soy diseñador web',              'exclude', 'any'),
  ('somos una agencia',              'exclude', 'any'),
  ('disponible para trabajar',       'exclude', 'any'),
  ('disponible para proyectos',      'exclude', 'any'),
  ('estoy buscando trabajo',         'exclude', 'any'),
  ('busco trabajo',                  'exclude', 'any'),
  ('busco empleo',                   'exclude', 'any'),
  ('mi portfolio',                   'exclude', 'any'),
  ('mi portafolio',                  'exclude', 'any'),
  ('vacante',                        'exclude', 'any'),
  ('sumate al equipo',               'exclude', 'any'),
  ('únete al equipo',                'exclude', 'any')
) as v(term, kind, lang)
where not exists (
  select 1 from keywords k
  where k.term = v.term and k.kind = v.kind and k.lang = v.lang
);

-- ===== Capa 4: tope de costo de la IA (presupuesto acumulado, duro) =====
-- `classifier_budget_usd`: tope en USD del gasto del clasificador. <= 0 o
--   ausente = ILIMITADO (para cuando se quiera "dejarlo libre").
-- `classifier_paused`: lo prende /api/process al llegar al tope (kill-switch);
--   el worker del firehose deja de encolar mientras esté en true.
insert into settings (key, value) values
  ('classifier_budget_usd', '5'::jsonb),
  ('classifier_paused',     'false'::jsonb)
on conflict (key) do nothing;

-- `classifier_spend_baseline_usd`: gasto acumulado AL MOMENTO de aplicar esta
-- migración. El gasto "efectivo" que cuenta contra el tope = SUM(llm_cost_usd de
-- los done) - baseline → así el tope de USD 5 se mide DESDE AHORA, sin contar lo
-- ya gastado. Se setea una sola vez (do nothing si ya existe).
insert into settings (key, value)
select
  'classifier_spend_baseline_usd',
  to_jsonb(coalesce((select sum(llm_cost_usd) from leads where llm_status = 'done'), 0)::float8)
on conflict (key) do nothing;

-- Suma total (USD) del gasto del clasificador hasta ahora. La usa /api/process
-- para decidir el kill-switch sin traer miles de filas: el agregado lo resuelve
-- la base. `security definer` para que ande igual bajo RLS.
create or replace function classifier_spend_total()
returns float8
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(llm_cost_usd), 0)::float8
  from leads
  where llm_status = 'done';
$$;

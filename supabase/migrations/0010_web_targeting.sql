-- 0010_web_targeting.sql
--
-- Afinar la detección hacia la intención "página web" (la oferta central del
-- dueño) sin sacar las queries más amplias de "developer/programador".
--
-- Forward-only e idempotente: re-correrla deja el mismo conjunto de queries
-- (se deduplica con DISTINCT). Sólo toca datos semilla; no cambia el esquema.
--
-- Contexto: la fuente Bluesky (`lib/sources/bluesky.ts`) es el mejor canal de
-- outreach 100% automático (búsqueda sin auth + DM por app password, sin worker
-- ni teléfonos). Sus queries originales (0001) apuntaban a "hire a developer";
-- acá se suman frases de quien busca puntualmente una página/landing/sitio web.

update sources
set config = jsonb_set(
  config,
  '{queries}',
  (
    select jsonb_agg(distinct elem order by elem)
    from jsonb_array_elements_text(
      coalesce(config -> 'queries', '[]'::jsonb)
      || to_jsonb(array[
           -- Español (rioplatense / LATAM)
           'necesito una página web',
           'necesito una pagina web',
           'quiero una página web',
           'busco quien me haga una web',
           'alguien que me haga una página web',
           'necesito una landing',
           'necesito un sitio web',
           'quiero hacer mi página web',
           -- Inglés
           'need a website',
           'looking for someone to build a website',
           'i need a website built',
           'need a landing page'
         ])
    ) as elem
  )
)
where slug = 'bluesky'
  and config ? 'queries';

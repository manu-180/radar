-- ===== Fuente Workana (paso 34, opcional) =====
--
-- Workana es la bolsa freelance más relevante para el mercado argentino/LatAm.
-- Es la única fuente con costo y fragilidad reales: no tiene API pública y está
-- detrás de Cloudflare, así que se baja vía un servicio de scraping pago
-- (SCRAPER_API_KEY, ~US$30–50/mes) y el parseo de su HTML se rompe con cada
-- cambio de markup.
--
-- Por eso arranca DESHABILITADA (enabled = false): se activa a mano desde el
-- panel solo cuando el scraping funcione y el dueño acepte el costo. Sin
-- SCRAPER_API_KEY el adaptador devuelve [] sin romper nada.
--
-- `config.searchUrls` son URLs de búsqueda de proyectos de Workana; las de abajo
-- son ejemplos editables desde el panel (Configuración → Fuentes → workana).
insert into sources (slug, name, enabled, config) values
  ('workana', 'Workana', false,
   '{"searchUrls": ["https://www.workana.com/jobs?category=it-programming&language=es", "https://www.workana.com/jobs?category=it-programming&language=en"]}'::jsonb)
on conflict (slug) do nothing;

-- ============================================================================
-- 0009 — Autopilot: conversaciones, mensajes, contacto/engage de leads
-- ============================================================================
-- Agrega la capa de v2 (closer autónomo) ENCIMA del detector de v1 sin tocarlo:
--   * leads: cómo contactar al autor + cola de "engage" (primer contacto).
--   * conversations: una charla por lead+canal, con estado, etapa, interés y
--     el switch de autopilot.
--   * messages: cada mensaje (entrante/saliente) de cada conversación.
--   * RPCs de claim resiliente (mismo patrón FOR UPDATE SKIP LOCKED de 0002/0007).
--   * settings nuevos del autopilot (apagado por defecto: modo "shadow").
--
-- IDEMPOTENTE en lo que se puede (add column / create index if not exists /
-- create or replace function / insert ... on conflict do nothing). Las tablas
-- nuevas usan `create table if not exists`.
-- ============================================================================

-- ── 1. leads: contacto + cola de engage ────────────────────────────────────
alter table leads add column if not exists contact_channel   text;
alter table leads add column if not exists contact_key        text;
alter table leads add column if not exists contact_ref        jsonb;
alter table leads add column if not exists contact_handle     text;
alter table leads add column if not exists engage_status      text not null default 'none'
  check (engage_status in ('none','pending','engaging','engaged','skipped'));
alter table leads add column if not exists engage_claimed_at  timestamptz;
alter table leads add column if not exists engaged_at         timestamptz;

-- Cola de engage: leads clasificados, contactables y aún sin enganchar.
create index if not exists leads_engage_pending_idx
  on leads (first_seen_at) where engage_status = 'pending';
-- Barrido de engages colgados (claim viejo), acotado a las filas en 'engaging'.
create index if not exists leads_engaging_idx
  on leads (engage_claimed_at) where engage_status = 'engaging';

-- ── 2. conversations ────────────────────────────────────────────────────────
create table if not exists conversations (
  id              bigint generated always as identity primary key,
  lead_id         bigint not null references leads(id) on delete cascade,
  channel         text not null,                      -- telegram|bluesky|whatsapp|reddit
  contact_key     text not null,                      -- clave de ruteo en el canal
  contact_ref     jsonb not null default '{}'::jsonb, -- direccionamiento completo (opaco)
  contact_handle  text,                               -- display: @user, +54…
  status          text not null default 'pending_outreach'
    check (status in ('pending_outreach','awaiting_reply','active','awaiting_owner',
                      'snoozed','wants_draft','handed_off','won','lost',
                      'disqualified','paused','failed')),
  stage           text not null default 'outreach'
    check (stage in ('outreach','greeted','discovery','offer','negotiation',
                     'scheduling','draft_requested','closed')),
  interest_level  integer not null default 0 check (interest_level between 0 and 100),
  autopilot       boolean not null default true,
  message_count   integer not null default 0,
  outbound_count  integer not null default 0,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  next_action_at   timestamptz,                       -- follow-up programado
  claimed_at       timestamptz,                       -- claim del turno (1 a la vez)
  summary         text,                               -- resumen vivo (contexto largo)
  last_error      text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Ruteo de entrantes O(1) + una sola conversación por lead+canal.
create unique index if not exists conversations_channel_contact_idx
  on conversations (channel, contact_key);
create index if not exists conversations_lead_idx on conversations (lead_id);
create index if not exists conversations_status_idx on conversations (status, updated_at desc);
-- Cola de follow-ups que vencieron.
create index if not exists conversations_due_idx
  on conversations (next_action_at)
  where status in ('awaiting_reply','snoozed') and next_action_at is not null;
-- Barrido de turnos colgados.
create index if not exists conversations_claimed_idx
  on conversations (claimed_at) where claimed_at is not null;

-- ── 3. messages ─────────────────────────────────────────────────────────────
create table if not exists messages (
  id               bigint generated always as identity primary key,
  conversation_id  bigint not null references conversations(id) on delete cascade,
  direction        text not null check (direction in ('inbound','outbound')),
  role             text not null check (role in ('lead','agent','owner','system')),
  body             text not null default '',
  channel_message_id text,
  status           text not null default 'received'
    check (status in ('received','queued','sending','sent','delivered','failed')),
  error            text,
  ai_model         text,
  input_tokens     integer,
  output_tokens    integer,
  ai_cost_usd      numeric(10,6),
  interest_level   integer check (interest_level between 0 and 100),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

create index if not exists messages_conversation_idx
  on messages (conversation_id, created_at);
-- Dedup de entrantes: un webhook reintentado no duplica el mensaje.
create unique index if not exists messages_provider_dedup_idx
  on messages (conversation_id, direction, channel_message_id)
  where channel_message_id is not null;

-- ── 4. RLS: cerrado al público (igual que v1; sólo service role) ────────────
alter table conversations enable row level security;
alter table messages      enable row level security;

-- ── 5. RPCs de claim resiliente ─────────────────────────────────────────────
-- 5.1 Leads listos para el primer contacto: clasificados ('done'), contactables
--     (contact_channel no nulo), que califican (categoría Y score) y siguen
--     'pending' (o 'engaging' colgado). Mismo patrón que claim_pending_leads.
create or replace function claim_leads_to_engage(batch_size int, cats text[], min_score int)
returns setof leads language sql as $$
  update leads set engage_status = 'engaging', engage_claimed_at = now()
  where id in (
    select id from leads
    where llm_status = 'done'
      and contact_channel is not null
      and (
        engage_status = 'pending'
        or (engage_status = 'engaging'
            and (engage_claimed_at is null
                 or engage_claimed_at < now() - interval '15 minutes'))
      )
      and category = any(cats)
      and score >= min_score
    order by first_seen_at limit batch_size
    for update skip locked
  )
  returning *;
$$;

-- 5.2 Conversaciones con un follow-up vencido, para reenganchar.
create or replace function claim_conversations_due(batch_size int)
returns setof conversations language sql as $$
  update conversations set claimed_at = now()
  where id in (
    select id from conversations
    where status in ('awaiting_reply','snoozed')
      and next_action_at is not null
      and next_action_at <= now()
      and (claimed_at is null or claimed_at < now() - interval '15 minutes')
    order by next_action_at limit batch_size
    for update skip locked
  )
  returning *;
$$;

-- 5.3 Toma UNA conversación para correr un turno del agente. Devuelve la fila
--     sólo si pudo reclamarla (no estaba tomada o el claim quedó viejo). Si
--     devuelve vacío, hay otro turno en vuelo: el llamador guarda el entrante y
--     sale (ese turno re-chequea mensajes nuevos al terminar). 5 min holgado
--     sobre el maxDuration de la ruta.
create or replace function claim_conversation_for_turn(conv_id bigint)
returns setof conversations language sql as $$
  update conversations set claimed_at = now()
  where id = conv_id
    and (claimed_at is null or claimed_at < now() - interval '5 minutes')
  returning *;
$$;

-- ── 5.4 Contadores de conversación, mantenidos por trigger (atómicos) ───────
-- Mantener `message_count` / `outbound_count` / `last_*_at` con un read-modify-
-- write desde la app sería propenso a carreras. Un trigger los actualiza de
-- forma atómica en cada insert de `messages`. Notas:
--   * `outbound_count` sólo cuenta mensajes del AGENTE (el tope de mensajes es
--     sobre el agente; los mensajes manuales del dueño no consumen ese cupo).
--   * `message_count` cuenta todo lo que no sea un evento de sistema.
create or replace function bump_conversation_counters()
returns trigger language plpgsql as $$
begin
  update conversations set
    message_count   = message_count + (case when new.role <> 'system' then 1 else 0 end),
    outbound_count  = outbound_count + (case when new.direction = 'outbound' and new.role = 'agent' then 1 else 0 end),
    last_inbound_at = (case when new.direction = 'inbound'  then now() else last_inbound_at  end),
    last_outbound_at= (case when new.direction = 'outbound' then now() else last_outbound_at end),
    updated_at      = now()
  where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists messages_bump_counters on messages;
create trigger messages_bump_counters
  after insert on messages
  for each row execute function bump_conversation_counters();

-- ── 5.5 runs.kind: habilitar las corridas nuevas (engage/followup/inbound) ──
-- Las rutas nuevas abren corridas de observabilidad con startRun(); el check de
-- `runs.kind` (migración 0001) sólo permitía poll/process/notify/health.
-- Se descubre el check por introspección (no por nombre fijo): así, sea cual sea
-- el nombre auto-generado del constraint, se reemplaza sin dejar uno viejo que
-- siga rechazando los kinds nuevos. Idempotente.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'runs'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table runs drop constraint %I', c.conname);
  end loop;
  alter table runs add constraint runs_kind_check
    check (kind in ('poll','process','notify','health','engage','followup','inbound'));
end $$;

-- ── 5.6 Auto-encolado para engage (sin tocar el código de v1) ───────────────
-- Cuando un lead queda clasificado ('done'), es contactable (tiene
-- contact_channel) y no es ruido, pasa solo a la cola de engage
-- (engage_status 'none' → 'pending'). Así `/api/process` (v1) no necesita saber
-- nada de v2, y el índice parcial `leads_engage_pending_idx` se mantiene chico.
-- El umbral de score/categoría real lo aplica `claim_leads_to_engage` con la
-- `engage_rule`; este trigger sólo deja al lead "elegible".
create or replace function flag_lead_for_engage()
returns trigger language plpgsql as $$
begin
  if new.llm_status = 'done'
     and new.contact_channel is not null
     and coalesce(new.category, '') <> 'noise'
     and new.engage_status = 'none' then
    new.engage_status := 'pending';
  end if;
  return new;
end $$;

drop trigger if exists leads_flag_engage on leads;
create trigger leads_flag_engage
  before update on leads
  for each row execute function flag_lead_for_engage();

-- ── 6. settings del autopilot (apagado por defecto: modo shadow) ────────────
insert into settings (key, value) values
  -- Interruptor maestro. Arranca APAGADO: el sistema detecta y prepara pero no
  -- contacta a nadie hasta que el dueño lo prenda desde el panel.
  ('outreach_enabled', 'false'::jsonb),
  -- Regla de elegibilidad para enganchar (default = la de notificación).
  ('engage_rule', '{"categories": ["hiring"], "minScore": 75}'::jsonb),
  -- Autopilot por canal. Reddit apagado: auto-DMear ahí banea cuentas.
  ('channel_autopilot',
   '{"telegram": true, "bluesky": true, "whatsapp": true, "reddit": false}'::jsonb),
  -- Tope de primeros contactos por día (anti-ban, global).
  ('outreach_daily_cap', '20'::jsonb),
  -- Tope de mensajes del agente en una conversación antes de un handoff forzado.
  ('agent_max_messages', '12'::jsonb),
  -- Política de reenganche: esperas (horas) y cuántos follow-ups como máximo.
  ('followup_policy', '{"delaysHours": [24, 72], "maxFollowups": 2}'::jsonb),
  -- Playbook del closer IA. Editable desde /config. Es el guion del agente.
  ('agent_playbook',
   '{
      "persona": "Sos un desarrollador freelance argentino, cercano y profesional. Hablás en español rioplatense, claro y sin vueltas, sin sonar a bot ni a vendedor agresivo.",
      "offer": "Hacés páginas web y apps a medida con Next.js, React y back-ends modernos (Supabase). Entrega rápida, diseño prolijo y precios competitivos. Mostrás ejemplos cuando suma.",
      "pricing": "Una landing simple arranca en USD 150-300; un sitio con varias secciones USD 300-700; una web app a medida se cotiza según alcance. Nunca cierres un precio fuera de estos rangos sin confirmar con el dueño.",
      "tone": "Cálido, directo, humano. Mensajes cortos de WhatsApp/DM. Una idea por mensaje. Hacé una sola pregunta por vez.",
      "goal": "Entender qué necesita, generar confianza y llevarlo a que pida una propuesta o un boceto. Cuando pida boceto/propuesta/presupuesto formal o quiera hablar con una persona, HACÉ HANDOFF (no mandes el boceto vos, no cierres plata).",
      "handoff_triggers": "pide un boceto o mockup, pide una propuesta o presupuesto formal por escrito, quiere agendar una llamada, pide hablar con la persona, o ya hay acuerdo de avanzar."
    }'::jsonb)
on conflict (key) do nothing;

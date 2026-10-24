-- The driver's chat with the agent. It replaces the one-tap report: the agent
-- answers what it can and raises an incident for control only when a problem
-- delays the delivery by a day or more, the car breaks down, or it may cost
-- extra. Only the driver-chat edge function writes here (service role);
-- drivers read their own conversation, staff read every one.

create table public.driver_chat_messages (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  vehicle_id text null references public.vehicles (id) on delete set null,
  role text not null check (role in ('driver', 'agent')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  -- Set on the agent's reply that told control.
  incident_id uuid null references public.incidents (id) on delete set null,
  created_at timestamptz not null default now()
);
create index driver_chat_messages_driver_idx on public.driver_chat_messages (driver_id, created_at desc);

alter table public.driver_chat_messages enable row level security;
revoke all on public.driver_chat_messages from anon, authenticated;
grant select on public.driver_chat_messages to authenticated;

create policy "drivers read their own chat" on public.driver_chat_messages
  for select to authenticated using (driver_id = (select auth.uid()));
create policy "staff read every chat" on public.driver_chat_messages
  for select to authenticated using ((select app.is_staff()));

alter publication supabase_realtime add table public.driver_chat_messages;

-- The clear button also clears chats written after the seed.
create or replace function public.clear_live_activity() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_seeded_at timestamptz;
  v_messages int;
  v_incidents int;
  v_suggestions int;
  v_chats int;
begin
  perform app.require_role('dispatcher', 'supervisor');

  -- The seed inserts every car in one transaction, so they share its time.
  select max(created_at) into v_seeded_at from public.vehicles;
  if v_seeded_at is null then
    raise exception 'No demo data found, so there is nothing safe to clear.' using errcode = 'P0002';
  end if;

  select count(*) into v_suggestions from public.agent_suggestions s
  join public.incidents i on i.id = s.incident_id
  where i.created_at > v_seeded_at and i.reported_by is not null;
  delete from public.incidents
  where created_at > v_seeded_at and reported_by is not null;  -- cascades to their agent_suggestions
  get diagnostics v_incidents = row_count;

  delete from public.messages where created_at > v_seeded_at;
  get diagnostics v_messages = row_count;

  delete from public.driver_chat_messages where created_at > v_seeded_at;
  get diagnostics v_chats = row_count;

  with gone as (
    delete from public.hotel_bookings where created_at > v_seeded_at returning hotel_id
  ), per_hotel as (
    select hotel_id, count(*) as n from gone group by hotel_id
  )
  update public.hotels h set rooms_left = h.rooms_left + p.n
  from per_hotel p where h.id = p.hotel_id;

  perform app.audit('live.cleared', jsonb_build_object(
    'since', v_seeded_at, 'messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions, 'chats', v_chats));
  return jsonb_build_object('messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions, 'chats', v_chats);
end
$$;

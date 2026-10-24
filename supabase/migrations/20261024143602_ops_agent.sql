-- The helper agent: what it may read, how its proposals are stored and
-- carried out, and what wakes it up.
--
-- Flow: an incident is inserted -> trigger calls agent-triage (pg_net, async,
-- so a slow or failing model never blocks the insert) -> the agent reads
-- context through the agent_* functions below and inserts a proposal: one or
-- more moves in agent_suggestions sharing a group_id -> a person approves or
-- rejects each move (decide_suggestion) -> on approval a trigger calls
-- execute-suggestion -> apply_suggestion carries out that one move.
--
-- Also: ferry and hotel data for the "missed ferry check-in" scenario, a
-- staff RPC that stages it, and a pg_cron job that flags cars gone quiet.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Ferry and hotel data ------------------------------------------------------------
-- Made up, like the rest of the dataset: the operator and hotels are fictional.

create table public.ports (
  id text primary key,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  timezone text not null
);

create table public.ferry_departures (
  id uuid primary key default gen_random_uuid(),
  operator text not null,
  from_port text not null references public.ports (id),
  to_port text not null references public.ports (id),
  departs_at timestamptz not null,
  check_in_closes_at timestamptz not null,
  rebooking_fee_cents integer not null check (rebooking_fee_cents >= 0),
  vehicle_slots_left integer not null check (vehicle_slots_left >= 0),
  created_at timestamptz not null default now(),
  check (check_in_closes_at < departs_at)
);
create index ferry_departures_route_idx on public.ferry_departures (from_port, departs_at);

create table public.ferry_bookings (
  id uuid primary key default gen_random_uuid(),
  vehicle_id text not null unique references public.vehicles (id) on delete cascade,
  departure_id uuid not null references public.ferry_departures (id),
  status text not null default 'booked' check (status in ('booked', 'rebooked', 'boarded', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.hotels (
  id text primary key,
  name text not null,
  port_id text not null references public.ports (id),
  distance_km numeric(4, 1) not null,
  nightly_rate_cents integer not null check (nightly_rate_cents >= 0),
  rooms_left integer not null check (rooms_left >= 0)
);

create table public.hotel_bookings (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  hotel_id text not null references public.hotels (id),
  nights integer not null check (nights between 1 and 3),
  cost_cents integer not null,
  suggestion_id uuid null,
  created_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.ferry_bookings
  for each row execute function app.set_updated_at();

insert into public.ports (id, name, lat, lng, timezone) values
  ('travemunde', 'Travemünde Skandinavienkai', 53.9600, 10.8667, 'Europe/Berlin'),
  ('helsinki-vuosaari', 'Helsinki Vuosaari', 60.2093, 25.1951, 'Europe/Helsinki');
insert into public.hotels (id, name, port_id, distance_km, nightly_rate_cents, rooms_left) values
  ('hotel-kai', 'Hotel Am Skandinavienkai', 'travemunde', 0.8, 8900, 4),
  ('hotel-priwall', 'Pension Priwall', 'travemunde', 2.1, 6400, 2),
  ('hotel-strand', 'Strandhotel Travemünde', 'travemunde', 3.5, 14500, 9);

alter table public.ports enable row level security;
alter table public.ferry_departures enable row level security;
alter table public.ferry_bookings enable row level security;
alter table public.hotels enable row level security;
alter table public.hotel_bookings enable row level security;
revoke all on public.ports, public.ferry_departures, public.ferry_bookings, public.hotels, public.hotel_bookings
  from anon, authenticated;
grant select on public.ports, public.ferry_departures, public.ferry_bookings, public.hotels, public.hotel_bookings
  to authenticated;

-- Timetables and hotels are reference data. Bookings are operational.
create policy "signed-in users read ports" on public.ports for select to authenticated using (true);
create policy "signed-in users read departures" on public.ferry_departures for select to authenticated using (true);
create policy "signed-in users read hotels" on public.hotels for select to authenticated using (true);
create policy "staff read ferry bookings" on public.ferry_bookings
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their car's ferry booking" on public.ferry_bookings
  for select to authenticated using (vehicle_id = (select app.my_vehicle()));
create policy "staff read hotel bookings" on public.hotel_bookings
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their hotel bookings" on public.hotel_bookings
  for select to authenticated using (driver_id = (select auth.uid()));

-- Proposals ---------------------------------------------------------------------
-- A proposal is the moves that share a group_id, in step order. Each move is
-- decided on its own: approving the ferry rebooking does not book the hotel.

alter table public.agent_suggestions
  add column group_id uuid null,
  add column step smallint not null default 1,
  add column title text null,
  add column cost_cents integer null check (cost_cents >= 0),
  -- The agent's stated reasoning for the whole proposal, as short ordered
  -- steps: what it checked and what it found. Same on every move of a group.
  add column reasoning_trace jsonb not null default '[]'::jsonb;
alter table public.agent_suggestions drop constraint agent_suggestions_suggestion_type_check;
alter table public.agent_suggestions add constraint agent_suggestions_suggestion_type_check
  check (suggestion_type in (
    'message_vehicle', 'message_corridor', 'set_vehicle_status', 'escalate_incident',
    'rebook_ferry', 'book_hotel'
  ));
create index agent_suggestions_group_idx on public.agent_suggestions (group_id, step);

-- Calling the edge functions ------------------------------------------------------
-- The project URL and a shared secret live in Vault. The secret is made here
-- and never leaves the database: the edge functions check a request by
-- asking verify_agent_secret, so nothing has to be copied into function env.
-- Set the URL once per project (see supabase/README.md):
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'agent_webhook_secret')
where not exists (select 1 from vault.secrets where name = 'agent_webhook_secret');

create or replace function app.call_function(p_name text, p_body jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'agent_webhook_secret';
  if v_url is null or v_secret is null then
    raise warning 'Agent not wired: set the project_url secret in Vault.';
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-agent-secret', v_secret),
    timeout_milliseconds := 10000
  );
end
$$;
revoke all on function app.call_function(text, jsonb) from public, anon, authenticated;

create or replace function public.verify_agent_secret(p_secret text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'agent_webhook_secret'), false)
$$;
revoke all on function public.verify_agent_secret(text) from public, anon, authenticated;
grant execute on function public.verify_agent_secret(text) to service_role;

-- Every new incident goes to the agent, except ones the agent raised itself.
create or replace function app.on_incident_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.source <> 'agent' then
    perform app.call_function('agent-triage', jsonb_build_object('incident_id', new.id));
  end if;
  return null;
end
$$;
create trigger agent_triage after insert on public.incidents
  for each row execute function app.on_incident_created();

create or replace function app.on_suggestion_approved() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.call_function('execute-suggestion', jsonb_build_object('suggestion_id', new.id));
  return null;
end
$$;
create trigger execute_suggestion after update of status on public.agent_suggestions
  for each row when (new.status = 'approved' and old.status = 'pending')
  execute function app.on_suggestion_approved();

-- What the agent may read ------------------------------------------------------------
-- Service role only. These are the agent's whole view of the world.

create or replace function app.km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable set search_path = '' as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;

create or replace function public.agent_incident_context(p_incident_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', now(),
    'incident', to_jsonb(i) - 'reported_by' - 'assigned_to' - 'acknowledged_by' - 'resolved_by',
    'reported_by_role', (select role from public.profiles where id = i.reported_by),
    'vehicle', to_jsonb(v),
    'driver', (select jsonb_build_object('full_name', p.full_name) from public.profiles p where p.vehicle_id = v.id and p.role = 'driver' limit 1),
    'corridor', (select jsonb_build_object('id', c.id, 'name', c.name) from public.corridors c where c.id = v.corridor_id),
    'ferry_booking', (
      select jsonb_build_object('status', b.status, 'operator', d.operator, 'from_port', d.from_port, 'to_port', d.to_port,
        'departs_at', d.departs_at, 'check_in_closes_at', d.check_in_closes_at)
      from public.ferry_bookings b join public.ferry_departures d on d.id = b.departure_id
      where b.vehicle_id = v.id),
    'nearby_vehicles', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label, 'status', o.status,
        'km_away', round(app.km(v.lat, v.lng, o.lat, o.lng)::numeric, 1), 'delay_seconds', o.delay_seconds)
        order by app.km(v.lat, v.lng, o.lat, o.lng))
      from public.vehicles o
      where o.id <> v.id and o.lat is not null and v.lat is not null
        and app.km(v.lat, v.lng, o.lat, o.lng) < 80), '[]'::jsonb),
    'recent_incidents_on_corridor', coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'severity', r.severity, 'status', r.status,
        'vehicle_id', r.vehicle_id, 'created_at', r.created_at, 'description', left(r.description, 200))
        order by r.created_at desc)
      from public.incidents r join public.vehicles rv on rv.id = r.vehicle_id
      where rv.corridor_id = v.corridor_id and r.id <> i.id and r.created_at > now() - interval '24 hours'), '[]'::jsonb),
    'recent_messages_to_vehicle', coalesce((
      select jsonb_agg(jsonb_build_object('body', m.body, 'created_at', m.created_at) order by m.created_at desc)
      from (select * from public.messages where to_vehicle = v.id order by created_at desc limit 5) m), '[]'::jsonb)
  )
  from public.incidents i join public.vehicles v on v.id = i.vehicle_id
  where i.id = p_incident_id
$$;

-- Can the car still make what it is booked on? For a car with a ferry
-- booking: ETA at the port from its last position (road distance ~1.25x the
-- straight line at 75 km/h, plus its current delay) against check-in close.
create or replace function public.agent_check_pickup_feasibility(p_vehicle_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.vehicles;
  d public.ferry_departures;
  p public.ports;
  v_km double precision;
  v_eta timestamptz;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  if not found then
    return jsonb_build_object('error', 'no such vehicle');
  end if;
  select dep.* into d from public.ferry_bookings b join public.ferry_departures dep on dep.id = b.departure_id
  where b.vehicle_id = p_vehicle_id and b.status in ('booked', 'rebooked');
  if not found then
    return jsonb_build_object('vehicle_id', v.id, 'destination', 'delivery',
      'eta', v.eta, 'delay_seconds', v.delay_seconds, 'last_seen_at', v.last_seen_at,
      'note', 'No ferry booking; the delivery ETA already includes the current delay.');
  end if;
  select * into p from public.ports where id = d.from_port;
  if v.lat is null then
    return jsonb_build_object('vehicle_id', v.id, 'destination', 'port', 'port', p.name,
      'feasible', null, 'note', 'No position known for this car.');
  end if;
  v_km := app.km(v.lat, v.lng, p.lat, p.lng) * 1.25;
  v_eta := now() + make_interval(secs => v_km / 75.0 * 3600 + v.delay_seconds);
  return jsonb_build_object(
    'vehicle_id', v.id, 'destination', 'port', 'port', p.name, 'port_timezone', p.timezone,
    'road_km_to_port', round(v_km::numeric, 1),
    'delay_seconds', v.delay_seconds,
    'eta_at_port', v_eta,
    'check_in_closes_at', d.check_in_closes_at,
    'departs_at', d.departs_at,
    'feasible', v_eta <= d.check_in_closes_at,
    'minutes_late', greatest(0, round(extract(epoch from (v_eta - d.check_in_closes_at)) / 60))
  );
end
$$;

create or replace function public.agent_find_next_ferry(p_from_port text, p_not_before timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'departure_id', d.id, 'operator', d.operator, 'from_port', d.from_port, 'to_port', d.to_port,
    'departs_at', d.departs_at, 'check_in_closes_at', d.check_in_closes_at,
    'rebooking_fee_cents', d.rebooking_fee_cents, 'vehicle_slots_left', d.vehicle_slots_left)
    order by d.departs_at), '[]'::jsonb)
  from (
    select * from public.ferry_departures
    where from_port = p_from_port and check_in_closes_at >= p_not_before and vehicle_slots_left > 0
    order by departs_at limit 3
  ) d
$$;

create or replace function public.agent_find_hotel_near_port(p_port_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'hotel_id', h.id, 'name', h.name, 'distance_km', h.distance_km,
    'nightly_rate_cents', h.nightly_rate_cents, 'rooms_left', h.rooms_left)
    order by h.nightly_rate_cents), '[]'::jsonb)
  from public.hotels h where h.port_id = p_port_id and h.rooms_left > 0
$$;

-- Carrying out one approved move ------------------------------------------------------
-- Only the moves listed here exist; anything else fails. Runs as the service
-- role from execute-suggestion, so it re-checks that a person approved it.

create or replace function public.apply_suggestion(p_suggestion_id uuid) returns public.agent_suggestions
language plpgsql security definer set search_path = '' as $$
declare
  s public.agent_suggestions;
  i public.incidents;
  v public.vehicles;
  d public.ferry_departures;
  h public.hotels;
  v_driver uuid;
  v_nights integer;
  v_body text;
begin
  select * into s from public.agent_suggestions where id = p_suggestion_id for update;
  if not found then
    raise exception 'No such suggestion.' using errcode = 'P0002';
  end if;
  if s.status <> 'approved' then
    raise exception 'Suggestion is %, not approved.', s.status using errcode = 'PT409';
  end if;
  select * into i from public.incidents where id = s.incident_id;
  select * into v from public.vehicles where id = i.vehicle_id for update;
  select id into v_driver from public.profiles where vehicle_id = v.id and role = 'driver' limit 1;

  begin
    case s.suggestion_type
    when 'message_vehicle' then
      insert into public.messages (to_vehicle, incident_id, body) values (v.id, i.id, s.payload ->> 'body');
    when 'message_corridor' then
      insert into public.messages (to_corridor, incident_id, body) values (v.corridor_id, i.id, s.payload ->> 'body');
    when 'set_vehicle_status' then
      update public.vehicles set status = (s.payload ->> 'status')::public.vehicle_status where id = v.id;
    when 'escalate_incident' then
      update public.incidents set
        severity = coalesce((s.payload ->> 'severity')::public.incident_severity, severity),
        assigned_to = (select id from public.profiles where role = 'supervisor' order by created_at limit 1)
      where id = i.id;
    when 'rebook_ferry' then
      select * into d from public.ferry_departures where id = (s.payload ->> 'departure_id')::uuid for update;
      if not found or d.check_in_closes_at < now() or d.vehicle_slots_left < 1 then
        raise exception 'That departure is gone or full.';
      end if;
      update public.ferry_departures set vehicle_slots_left = vehicle_slots_left - 1 where id = d.id;
      insert into public.ferry_bookings (vehicle_id, departure_id, status) values (v.id, d.id, 'rebooked')
      on conflict (vehicle_id) do update set departure_id = excluded.departure_id, status = 'rebooked';
      v_body := coalesce(s.payload ->> 'driver_message',
        format('Control rebooked your ferry: %s, departs %s, check-in closes %s (local time).', d.operator,
          to_char(d.departs_at at time zone 'Europe/Berlin', 'Dy HH24:MI'),
          to_char(d.check_in_closes_at at time zone 'Europe/Berlin', 'Dy HH24:MI')));
      insert into public.messages (to_vehicle, incident_id, body) values (v.id, i.id, v_body);
    when 'book_hotel' then
      if v_driver is null then
        raise exception 'No driver on this car.';
      end if;
      select * into h from public.hotels where id = s.payload ->> 'hotel_id' for update;
      if not found or h.rooms_left < 1 then
        raise exception 'That hotel is gone or full.';
      end if;
      v_nights := coalesce((s.payload ->> 'nights')::integer, 1);
      update public.hotels set rooms_left = rooms_left - 1 where id = h.id;
      insert into public.hotel_bookings (driver_id, hotel_id, nights, cost_cents, suggestion_id)
      values (v_driver, h.id, v_nights, h.nightly_rate_cents * v_nights, s.id);
      v_body := coalesce(s.payload ->> 'driver_message',
        format('Control booked you a room at %s, %s km from the port, for %s night(s). Keep your receipt.',
          h.name, h.distance_km, v_nights));
      insert into public.messages (to_vehicle, incident_id, body) values (v.id, i.id, v_body);
    end case;
  exception when others then
    update public.agent_suggestions set status = 'failed', error = sqlerrm where id = s.id returning * into s;
    insert into public.audit_log (actor_type, action, details)
    values ('agent', 'suggestion.failed', jsonb_build_object('suggestion_id', s.id, 'error', sqlerrm));
    return s;
  end;

  update public.agent_suggestions set status = 'executed', executed_at = now(), error = null
  where id = s.id returning * into s;
  insert into public.audit_log (actor_type, action, details)
  values ('agent', 'suggestion.execute', jsonb_build_object(
    'suggestion_id', s.id, 'incident_id', s.incident_id, 'suggestion_type', s.suggestion_type,
    'payload', s.payload, 'approved_by', s.decided_by));
  return s;
end
$$;

revoke all on function
  public.agent_incident_context(uuid),
  public.agent_check_pickup_feasibility(text),
  public.agent_find_next_ferry(text, timestamptz),
  public.agent_find_hotel_near_port(text),
  public.apply_suggestion(uuid)
  from public, anon, authenticated;
grant execute on function
  public.agent_incident_context(uuid),
  public.agent_check_pickup_feasibility(text),
  public.agent_find_next_ferry(text, timestamptz),
  public.agent_find_hotel_near_port(text),
  public.apply_suggestion(uuid)
  to service_role;

-- Staging the ferry scenario --------------------------------------------------------------
-- Cologne -> Helsinki car (ord-00584) is on the A1 near Bargteheide, in a Stau,
-- booked on tonight's Travemünde sailing. Times are relative to now so the
-- demo works at any hour: check-in closes in 60 minutes, the car needs ~90.

create or replace function public.simulate_ferry_jam() returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare
  v_first uuid;
  v_row public.incidents;
begin
  perform app.require_role('dispatcher', 'supervisor');
  if not exists (select 1 from public.vehicles where id = 'veh-00584') then
    raise exception 'Seed the demo data first (supabase/seed.sql).' using errcode = 'P0002';
  end if;

  delete from public.ferry_bookings where vehicle_id = 'veh-00584';
  delete from public.ferry_departures where operator = 'Baltic Link' and from_port = 'travemunde';
  insert into public.ferry_departures (operator, from_port, to_port, departs_at, check_in_closes_at, rebooking_fee_cents, vehicle_slots_left)
  values ('Baltic Link', 'travemunde', 'helsinki-vuosaari', now() + interval '2 hours', now() + interval '1 hour', 0, 0)
  returning id into v_first;
  insert into public.ferry_departures (operator, from_port, to_port, departs_at, check_in_closes_at, rebooking_fee_cents, vehicle_slots_left) values
    ('Baltic Link', 'travemunde', 'helsinki-vuosaari', now() + interval '14 hours', now() + interval '12 hours 30 minutes', 7500, 6),
    ('Baltic Link', 'travemunde', 'helsinki-vuosaari', now() + interval '26 hours', now() + interval '24 hours 30 minutes', 7500, 11);
  insert into public.ferry_bookings (vehicle_id, departure_id) values ('veh-00584', v_first);

  update public.vehicles set
    lat = 53.7333, lng = 10.2667, status = 'moving', delay_seconds = 2700, last_seen_at = now()
  where id = 'veh-00584';

  insert into public.incidents (vehicle_id, kind, severity, description)
  values ('veh-00584', 'ferry', 'high',
    '[Simulation] Driver reports a Stau on the A1 northbound near Bargteheide, about 45 minutes standing. Car is booked on tonight''s Baltic Link sailing from Travemünde.')
  returning * into v_row;
  perform app.audit('scenario.ferry_jam', jsonb_build_object('incident_id', v_row.id));
  return v_row;
end
$$;
revoke all on function public.simulate_ferry_jam() from public, anon;
grant execute on function public.simulate_ferry_jam() to authenticated;

-- Cars gone quiet ----------------------------------------------------------------------------
-- A moving car silent for 2-10 minutes gets a tracking_gap incident, once. The
-- upper bound means a stopped simulator raises one round, not one every
-- minute forever; resolved gaps are not raised again for 30 minutes.

create or replace function app.flag_stale_vehicles() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.incidents (vehicle_id, source, kind, severity, description)
  select v.id, 'system', 'tracking_gap', 'medium',
    format('No position from the driver app for %s minutes.', round(extract(epoch from now() - v.last_seen_at) / 60))
  from public.vehicles v
  where v.status = 'moving'
    and v.last_seen_at between now() - interval '10 minutes' and now() - interval '2 minutes'
    and not exists (
      select 1 from public.incidents i
      where i.vehicle_id = v.id and i.kind = 'tracking_gap'
        and (i.status <> 'resolved' or i.resolved_at > now() - interval '30 minutes'));
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

select cron.schedule('flag-stale-vehicles', '* * * * *', 'select app.flag_stale_vehicles()');

alter publication supabase_realtime add table public.ferry_bookings, public.hotel_bookings;

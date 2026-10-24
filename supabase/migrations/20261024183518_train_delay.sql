-- The train-delay double recovery. A driver travelling to a pickup by train
-- is hours late; pickup-watch (an edge function, on pg_cron and on demand)
-- compares their ETA with the dealer's key handover and raises a delay
-- incident when they will not make it. The agent then tells the driver and
-- proposes a replacement driver nearby, a bed for tonight and tomorrow's job
-- from the driver market. Additive: nothing existing is dropped.
--
-- Driver positions. Before pickup the driver is not in the car, so their own
-- position lives on profiles; report_position writes there while the car
-- waits for pickup.

-- Tables ---------------------------------------------------------------------

create table public.pickup_sites (
  id text primary key,
  name text not null,
  city text not null,
  lat double precision not null,
  lng double precision not null,
  timezone text not null,
  opening_hours jsonb not null default '{}'::jsonb,
  -- Today's closing time. Keys cannot be handed over after it unless
  -- key_handover is key_box.
  closes_at timestamptz null,
  key_handover text not null default 'unknown' check (key_handover in ('staff_only', 'key_box', 'unknown')),
  access_note text not null default ''
);

create table public.driver_trips (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  mode text not null default 'train' check (mode in ('train', 'bus', 'flight')),
  service text not null,                     -- "ICE 583"
  from_name text not null,
  to_name text not null,
  to_lat double precision not null,
  to_lng double precision not null,
  scheduled_arrival timestamptz not null,
  delay_minutes integer not null default 0 check (delay_minutes >= 0),
  -- A staged trip: live GPS from the driver app does not move this driver.
  simulated boolean not null default false,
  status text not null default 'travelling' check (status in ('travelling', 'arrived', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index driver_trips_driver_idx on public.driver_trips (driver_id, created_at desc);

-- The driver market: published jobs a freelance driver can take.
create table public.market_jobs (
  id text primary key,
  order_ref text not null,
  label text not null,
  pickup_name text not null,
  pickup_city text not null,
  pickup_lat double precision not null,
  pickup_lng double precision not null,
  timezone text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  delivery_city text not null,
  fee_cents integer not null check (fee_cents >= 0),
  status text not null default 'open' check (status in ('open', 'offered', 'accepted', 'declined')),
  offered_to uuid null references public.profiles (id) on delete set null,
  offer_suggestion_id uuid null,
  updated_at timestamptz not null default now(),
  check (window_end > window_start)
);

-- A night booked for a driver. The hotel comes from Google Places, so there
-- is no price here: the driver pays and claims it back.
create table public.driver_stays (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  place_id text not null,
  name text not null,
  address text not null default '',
  lat double precision null,
  lng double precision null,
  nights integer not null default 1 check (nights between 1 and 3),
  suggestion_id uuid null,
  created_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.driver_trips
  for each row execute function app.set_updated_at();
create trigger set_updated_at before update on public.market_jobs
  for each row execute function app.set_updated_at();

alter table public.vehicles
  add column pickup_site_id text null references public.pickup_sites (id),
  add column pickup_eta timestamptz null,
  add column pickup_in_time boolean null,
  add column pickup_checked_at timestamptz null,
  -- What the ETA is based on, in words: "ICE 583 +180 min, then 14 min drive (Google)".
  add column pickup_eta_basis text null;

alter table public.profiles
  add column lat double precision null check (lat between -90 and 90),
  add column lng double precision null check (lng between -180 and 180),
  add column position_at timestamptz null,
  add column availability text not null default 'off' check (availability in ('on_job', 'available', 'off'));
update public.profiles set availability = 'on_job' where role = 'driver' and vehicle_id is not null;

alter table public.agent_suggestions drop constraint agent_suggestions_suggestion_type_check;
alter table public.agent_suggestions add constraint agent_suggestions_suggestion_type_check
  check (suggestion_type in (
    'message_vehicle', 'message_corridor', 'set_vehicle_status', 'escalate_incident',
    'rebook_ferry', 'book_hotel', 'reassign_driver', 'book_stay', 'offer_market_job'
  ));

-- RLS --------------------------------------------------------------------------

alter table public.pickup_sites enable row level security;
alter table public.driver_trips enable row level security;
alter table public.market_jobs enable row level security;
alter table public.driver_stays enable row level security;
revoke all on public.pickup_sites, public.driver_trips, public.market_jobs, public.driver_stays from anon, authenticated;
grant select on public.pickup_sites, public.driver_trips, public.market_jobs, public.driver_stays to authenticated;

create policy "signed-in users read pickup sites" on public.pickup_sites
  for select to authenticated using (true);
create policy "staff read driver trips" on public.driver_trips
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their own trips" on public.driver_trips
  for select to authenticated using (driver_id = (select auth.uid()));
create policy "staff read the driver market" on public.market_jobs
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read open jobs and jobs offered to them" on public.market_jobs
  for select to authenticated using (status = 'open' or offered_to = (select auth.uid()));
create policy "staff read driver stays" on public.driver_stays
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their own stays" on public.driver_stays
  for select to authenticated using (driver_id = (select auth.uid()));

-- Reference data ------------------------------------------------------------------
-- Made up, like the rest of the demo. The Munich dealer is where veh-01024 waits.

insert into public.pickup_sites (id, name, city, lat, lng, timezone, opening_hours, key_handover, access_note) values
  ('site-muc-isartal', 'Autohaus Isartal München', 'Munich', 48.20637, 11.55466, 'Europe/Berlin',
   '{"mon_fri": "08:00-19:00", "sat": "09:00-14:00", "sun": null}', 'staff_only',
   'Keys are handed over in person at the service desk against the order reference and driver ID. No key box, no after-hours collection.')
on conflict (id) do nothing;
update public.vehicles set pickup_site_id = 'site-muc-isartal' where id = 'veh-01024';

-- Driver positions --------------------------------------------------------------
-- While the car waits for pickup the driver is not in it: their position is
-- theirs. A staged (simulated) trip keeps live GPS from moving the driver.

create or replace function public.report_position(
  p_lat double precision,
  p_lng double precision,
  p_delay_seconds integer default null,
  p_eta timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_vehicle text;
  v_status public.vehicle_status;
  v_last timestamptz;
begin
  perform app.require_role('driver');
  select vehicle_id into v_vehicle from public.profiles where id = auth.uid();
  if v_vehicle is null then
    raise exception 'You are not on a car.' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'That is not a position.' using errcode = '22023';
  end if;

  select last_seen_at, status into v_last, v_status from public.vehicles where id = v_vehicle for update;

  if v_status = 'waiting_pickup' then
    if exists (select 1 from public.driver_trips where driver_id = auth.uid() and simulated and status = 'travelling') then
      return jsonb_build_object('saved', false, 'vehicle_id', v_vehicle, 'reason', 'simulated trip');
    end if;
    update public.profiles set lat = p_lat, lng = p_lng, position_at = now() where id = auth.uid();
    return jsonb_build_object('saved', true, 'vehicle_id', v_vehicle, 'driver_only', true, 'next_at', now() + interval '12 seconds');
  end if;

  if v_last is not null and v_last > now() - interval '12 seconds' then
    return jsonb_build_object('saved', false, 'vehicle_id', v_vehicle, 'next_at', v_last + interval '12 seconds');
  end if;

  update public.vehicles set
    lat = p_lat,
    lng = p_lng,
    delay_seconds = coalesce(p_delay_seconds, delay_seconds),
    eta = coalesce(p_eta, eta),
    last_seen_at = now(),
    status = case when status = 'offline' then 'moving'::public.vehicle_status else status end
  where id = v_vehicle;
  update public.profiles set lat = p_lat, lng = p_lng, position_at = now() where id = auth.uid();
  return jsonb_build_object('saved', true, 'vehicle_id', v_vehicle, 'next_at', now() + interval '12 seconds');
end
$$;

-- What the agent and pickup-watch read ------------------------------------------------
-- Service role only, like the other agent_* functions.

create or replace function public.agent_pickup_context(p_vehicle_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', now(),
    'vehicle', jsonb_build_object('id', v.id, 'label', v.label, 'order_ref', v.order_ref, 'status', v.status,
      'pickup_eta', v.pickup_eta, 'pickup_in_time', v.pickup_in_time),
    'site', (select jsonb_build_object('id', s.id, 'name', s.name, 'city', s.city, 'lat', s.lat, 'lng', s.lng,
      'timezone', s.timezone, 'opening_hours', s.opening_hours, 'closes_at', s.closes_at,
      'key_handover', s.key_handover, 'access_note', s.access_note)
      from public.pickup_sites s where s.id = v.pickup_site_id),
    'driver', (select jsonb_build_object('id', p.id, 'full_name', p.full_name, 'lat', p.lat, 'lng', p.lng,
      'position_at', p.position_at)
      from public.profiles p where p.vehicle_id = v.id and p.role = 'driver' limit 1),
    'trip', (select jsonb_build_object('id', t.id, 'mode', t.mode, 'service', t.service, 'from_name', t.from_name,
      'to_name', t.to_name, 'to_lat', t.to_lat, 'to_lng', t.to_lng, 'scheduled_arrival', t.scheduled_arrival,
      'delay_minutes', t.delay_minutes, 'expected_arrival', t.scheduled_arrival + make_interval(mins => t.delay_minutes),
      'simulated', t.simulated)
      from public.driver_trips t
      join public.profiles p on p.id = t.driver_id and p.vehicle_id = v.id and p.role = 'driver'
      where t.status = 'travelling' order by t.created_at desc limit 1)
  )
  from public.vehicles v where v.id = p_vehicle_id
$$;

-- Cars the watcher looks at: waiting for pickup, with a site and a driver
-- whose position or trip is known.
create or replace function public.agent_pickups_to_watch() returns setof text
language sql stable security definer set search_path = '' as $$
  select v.id from public.vehicles v
  join public.profiles p on p.vehicle_id = v.id and p.role = 'driver'
  where v.status = 'waiting_pickup' and v.pickup_site_id is not null
    and (p.lat is not null or exists (select 1 from public.driver_trips t where t.driver_id = p.id and t.status = 'travelling'))
$$;

-- Free drivers near a car's pickup site, nearest first (straight line; the
-- agent asks Google for real drive times).
create or replace function public.agent_available_drivers(p_vehicle_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(c order by (c ->> 'km_straight')::numeric), '[]'::jsonb)
  from (
    select jsonb_build_object('driver_id', p.id, 'full_name', p.full_name, 'lat', p.lat, 'lng', p.lng,
      'position_at', p.position_at, 'km_straight', round(app.km(p.lat, p.lng, s.lat, s.lng)::numeric, 1)) as c
    from public.vehicles v
    join public.pickup_sites s on s.id = v.pickup_site_id
    join public.profiles p on p.role = 'driver' and p.vehicle_id is null and p.availability = 'available' and p.lat is not null
    where v.id = p_vehicle_id and app.km(p.lat, p.lng, s.lat, s.lng) < 150
    order by app.km(p.lat, p.lng, s.lat, s.lng)
    limit 5
  ) x
$$;

create or replace function public.agent_find_market_jobs(p_lat double precision, p_lng double precision, p_after timestamptz)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(j order by (j ->> 'km_straight')::numeric), '[]'::jsonb)
  from (
    select jsonb_build_object('job_id', m.id, 'order_ref', m.order_ref, 'label', m.label,
      'pickup_name', m.pickup_name, 'pickup_city', m.pickup_city, 'pickup_lat', m.pickup_lat, 'pickup_lng', m.pickup_lng,
      'timezone', m.timezone, 'window_start', m.window_start, 'window_end', m.window_end,
      'delivery_city', m.delivery_city, 'fee_cents', m.fee_cents,
      'km_straight', round(app.km(p_lat, p_lng, m.pickup_lat, m.pickup_lng)::numeric, 1)) as j
    from public.market_jobs m
    where m.status = 'open' and m.window_start >= p_after and app.km(p_lat, p_lng, m.pickup_lat, m.pickup_lng) < 150
    order by app.km(p_lat, p_lng, m.pickup_lat, m.pickup_lng)
    limit 4
  ) x
$$;

revoke all on function
  public.agent_pickup_context(text),
  public.agent_pickups_to_watch(),
  public.agent_available_drivers(text),
  public.agent_find_market_jobs(double precision, double precision, timestamptz)
  from public, anon, authenticated;
grant execute on function
  public.agent_pickup_context(text),
  public.agent_pickups_to_watch(),
  public.agent_available_drivers(text),
  public.agent_find_market_jobs(double precision, double precision, timestamptz)
  to service_role;

-- Carrying out one approved move ------------------------------------------------------
-- As before, plus reassign_driver, book_stay and offer_market_job. The
-- stranded driver's id travels in the payload: after a reassign the car's
-- driver is someone else.

create or replace function app.maps_link(p_lat double precision, p_lng double precision) returns text
language sql immutable set search_path = '' as $$
  select format('https://www.google.com/maps/dir/?api=1&destination=%s,%s', p_lat, p_lng)
$$;

create or replace function public.apply_suggestion(p_suggestion_id uuid) returns public.agent_suggestions
language plpgsql security definer set search_path = '' as $$
declare
  s public.agent_suggestions;
  i public.incidents;
  v public.vehicles;
  d public.ferry_departures;
  h public.hotels;
  site public.pickup_sites;
  np public.profiles;
  job public.market_jobs;
  v_driver uuid;
  v_from uuid;
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

    when 'reassign_driver' then
      select * into np from public.profiles where id = (s.payload ->> 'driver_id')::uuid for update;
      if not found or np.role <> 'driver' or np.vehicle_id is not null or np.availability <> 'available' then
        raise exception 'That driver is no longer free.';
      end if;
      v_from := coalesce((s.payload ->> 'from_driver_id')::uuid, v_driver);
      select * into site from public.pickup_sites where id = v.pickup_site_id;
      update public.profiles set vehicle_id = null, availability = 'available' where id = v_from and vehicle_id = v.id;
      update public.profiles set vehicle_id = v.id, availability = 'on_job' where id = np.id;
      update public.assignments set status = 'cancelled' where vehicle_id = v.id and status in ('planned', 'active');
      insert into public.assignments (driver_id, vehicle_id, shift_start, shift_end, status)
      values (np.id, v.id, now(), now() + interval '10 hours', 'active');
      update public.vehicles set pickup_eta = null, pickup_in_time = null, pickup_eta_basis = null where id = v.id;
      v_body := format('Control has given you a pickup: %s (%s) at %s, %s.%s %s Navigate: %s',
        v.label, coalesce(v.order_ref, v.id), coalesce(site.name, 'the dealer'), coalesce(site.city, ''),
        case when site.closes_at is not null
          then format(' Keys are handed over in person until %s local time, so please head there now.',
            to_char(site.closes_at at time zone site.timezone, 'HH24:MI'))
          else '' end,
        coalesce(s.payload ->> 'driver_message', ''),
        app.maps_link(coalesce(site.lat, v.lat), coalesce(site.lng, v.lng)));
      insert into public.messages (to_user, incident_id, body) values (np.id, i.id, btrim(replace(v_body, '  ', ' ')));
      if v_from is not null then
        insert into public.messages (to_user, incident_id, body) values (v_from, i.id,
          format('%s is taking over the pickup of %s, so you do not need to go to the dealer today. Control will be in touch about tonight and tomorrow.',
            np.full_name, v.label));
      end if;
      perform app.call_function('pickup-watch', jsonb_build_object('vehicle_id', v.id));

    when 'book_stay' then
      v_from := (s.payload ->> 'driver_id')::uuid;
      if v_from is null or s.payload ->> 'place_id' is null then
        raise exception 'The stay has no driver or hotel.';
      end if;
      v_nights := coalesce((s.payload ->> 'nights')::integer, 1);
      insert into public.driver_stays (driver_id, place_id, name, address, lat, lng, nights, suggestion_id)
      values (v_from, s.payload ->> 'place_id', s.payload ->> 'name', coalesce(s.payload ->> 'address', ''),
        (s.payload ->> 'lat')::double precision, (s.payload ->> 'lng')::double precision, v_nights, s.id);
      v_body := format('Control has booked you a room for tonight: %s, %s (%s night%s). Pay at the hotel and claim it back with the receipt.%s%s',
        s.payload ->> 'name', coalesce(s.payload ->> 'address', ''), v_nights, case when v_nights > 1 then 's' else '' end,
        coalesce(' ' || nullif(s.payload ->> 'driver_message', ''), ''),
        case when s.payload ? 'lat' then ' Navigate: ' || app.maps_link((s.payload ->> 'lat')::double precision, (s.payload ->> 'lng')::double precision) else '' end);
      insert into public.messages (to_user, incident_id, body) values (v_from, i.id, v_body);

    when 'offer_market_job' then
      v_from := (s.payload ->> 'driver_id')::uuid;
      select * into job from public.market_jobs where id = s.payload ->> 'job_id' for update;
      if not found or job.status <> 'open' or v_from is null then
        raise exception 'That job is no longer open.';
      end if;
      update public.market_jobs set status = 'offered', offered_to = v_from, offer_suggestion_id = s.id where id = job.id;
      v_body := format('A job for tomorrow, if you want it: %s (%s) from %s, %s to %s, pickup %s–%s local, fee %s EUR. Accept or decline it in the app.%s',
        job.label, job.order_ref, job.pickup_name, job.pickup_city, job.delivery_city,
        to_char(job.window_start at time zone job.timezone, 'Dy HH24:MI'), to_char(job.window_end at time zone job.timezone, 'HH24:MI'),
        to_char(job.fee_cents / 100.0, 'FM999990.00'),
        coalesce(' ' || nullif(s.payload ->> 'driver_message', ''), ''));
      insert into public.messages (to_user, incident_id, body) values (v_from, i.id, v_body);
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
revoke all on function public.apply_suggestion(uuid) from public, anon, authenticated;
grant execute on function public.apply_suggestion(uuid) to service_role;

-- The driver answers a job offer ------------------------------------------------------------

create or replace function public.answer_market_job(p_job_id text, p_accept boolean) returns public.market_jobs
language plpgsql security definer set search_path = '' as $$
declare
  job public.market_jobs;
  v_staff uuid;
begin
  perform app.require_role('driver');
  select * into job from public.market_jobs where id = p_job_id for update;
  if not found or job.offered_to is distinct from auth.uid() then
    raise exception 'That job was not offered to you.' using errcode = 'P0002';
  end if;
  if job.status <> 'offered' then
    raise exception 'You already answered this offer.' using errcode = 'PT409';
  end if;
  update public.market_jobs set status = case when p_accept then 'accepted' else 'declined' end
  where id = job.id returning * into job;
  perform app.audit('market_job.' || job.status, jsonb_build_object('job_id', job.id, 'order_ref', job.order_ref));

  select decided_by into v_staff from public.agent_suggestions where id = job.offer_suggestion_id;
  v_staff := coalesce(v_staff, (select id from public.profiles where role = 'dispatcher' order by created_at limit 1));
  if v_staff is not null then
    insert into public.messages (to_user, body) values (v_staff,
      format('I %s the job %s (%s) for tomorrow.', case when p_accept then 'accept' else 'decline' end, job.order_ref, job.label));
  end if;
  return job;
end
$$;
revoke all on function public.answer_market_job(text, boolean) from public, anon;
grant execute on function public.answer_market_job(text, boolean) to authenticated;

-- Staging the train-delay scenario ------------------------------------------------------------
-- Elias Halverick is on ICE 583 from Hamburg to collect veh-01024 (Porsche
-- Macan) at the Munich dealer. The train stands south of Nuremberg, 180 min
-- late. The dealer closes in 90 minutes and hands keys over in person only.
-- Times are relative to now so the demo works at any hour. This raises no
-- incident: pickup-watch has to notice.

create or replace function public.simulate_train_delay() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_elias constant uuid := '10000000-0000-4000-8000-000000000015';
  v_closes timestamptz := now() + interval '90 minutes';
  v_tomorrow date := (now() at time zone 'Europe/Berlin')::date + 1;
begin
  perform app.require_role('dispatcher', 'supervisor');
  if not exists (select 1 from public.vehicles where id = 'veh-01024')
     or not exists (select 1 from public.profiles where id = v_elias) then
    raise exception 'Seed the demo data first (supabase/seed.sql).' using errcode = 'P0002';
  end if;

  -- The previous run.
  delete from public.messages where incident_id in (
    select id from public.incidents where vehicle_id = 'veh-01024' and description like '[Simulation]%');
  delete from public.incidents where vehicle_id = 'veh-01024' and description like '[Simulation]%';
  delete from public.driver_stays where driver_id in (
    v_elias, '10000000-0000-4000-8000-000000000016', '10000000-0000-4000-8000-000000000017', '10000000-0000-4000-8000-000000000018');
  delete from public.driver_trips where driver_id = v_elias;
  update public.profiles set vehicle_id = null, availability = 'available'
  where vehicle_id = 'veh-01024' and id <> v_elias;
  update public.profiles p set availability = 'available', lat = h.lat, lng = h.lng, position_at = now() - interval '4 minutes'
  from (values
    ('10000000-0000-4000-8000-000000000016'::uuid, 48.4029, 11.7488),   -- Freising
    ('10000000-0000-4000-8000-000000000017'::uuid, 48.3705, 10.8978),   -- Augsburg
    ('10000000-0000-4000-8000-000000000018'::uuid, 48.7665, 11.4258)    -- Ingolstadt
  ) as h (id, lat, lng)
  where p.id = h.id and p.role = 'driver' and p.vehicle_id is null;
  delete from public.assignments where vehicle_id = 'veh-01024' and driver_id <> v_elias;
  update public.assignments set status = 'active' where vehicle_id = 'veh-01024' and driver_id = v_elias;

  -- The world.
  update public.pickup_sites set
    closes_at = v_closes,
    opening_hours = jsonb_build_object('today', '08:00-' || to_char(v_closes at time zone 'Europe/Berlin', 'HH24:MI')),
    key_handover = 'staff_only'
  where id = 'site-muc-isartal';
  update public.vehicles set
    status = 'waiting_pickup', pickup_site_id = 'site-muc-isartal', lat = 48.20637, lng = 11.55466,
    pickup_eta = null, pickup_in_time = null, pickup_checked_at = null, pickup_eta_basis = null
  where id = 'veh-01024';
  update public.profiles set vehicle_id = 'veh-01024', availability = 'on_job',
    lat = 49.2470, lng = 11.2290, position_at = now()
  where id = v_elias;
  insert into public.driver_trips (driver_id, mode, service, from_name, to_name, to_lat, to_lng, scheduled_arrival, delay_minutes, simulated)
  values (v_elias, 'train', 'ICE 583', 'Hamburg Hbf', 'München Hbf', 48.1402, 11.5600, now() + interval '45 minutes', 180, true);

  insert into public.market_jobs (id, order_ref, label, pickup_name, pickup_city, pickup_lat, pickup_lng, timezone, window_start, window_end, delivery_city, fee_cents)
  values
    ('mj-muc-1', 'CD-421140', 'BMW iX xDrive50', 'Autopark Schwabing', 'Munich', 48.1675, 11.5860, 'Europe/Berlin',
      (v_tomorrow + time '09:00') at time zone 'Europe/Berlin', (v_tomorrow + time '11:00') at time zone 'Europe/Berlin', 'Hamburg', 38000),
    ('mj-muc-2', 'CD-421141', 'Audi e-tron GT', 'Autohaus Garching Nord', 'Garching', 48.2490, 11.6510, 'Europe/Berlin',
      (v_tomorrow + time '10:00') at time zone 'Europe/Berlin', (v_tomorrow + time '12:00') at time zone 'Europe/Berlin', 'Copenhagen', 52000),
    ('mj-muc-3', 'CD-421142', 'Volkswagen ID. Buzz', 'Inntal Automobile', 'Rosenheim', 47.8561, 12.1225, 'Europe/Berlin',
      (v_tomorrow + time '08:00') at time zone 'Europe/Berlin', (v_tomorrow + time '10:00') at time zone 'Europe/Berlin', 'Frankfurt', 29000),
    ('mj-nue-1', 'CD-421143', 'Porsche Cayenne', 'Frankenwerk Nürnberg', 'Nuremberg', 49.4521, 11.0767, 'Europe/Berlin',
      (v_tomorrow + time '13:00') at time zone 'Europe/Berlin', (v_tomorrow + time '15:00') at time zone 'Europe/Berlin', 'Berlin', 34000)
  on conflict (id) do update set status = 'open', offered_to = null, offer_suggestion_id = null,
    window_start = excluded.window_start, window_end = excluded.window_end;

  perform app.audit('scenario.train_delay', jsonb_build_object('vehicle_id', 'veh-01024'));
  perform app.call_function('pickup-watch', jsonb_build_object('vehicle_id', 'veh-01024'));
  return jsonb_build_object('vehicle_id', 'veh-01024', 'order_ref', (select order_ref from public.vehicles where id = 'veh-01024'));
end
$$;
revoke all on function public.simulate_train_delay() from public, anon;
grant execute on function public.simulate_train_delay() to authenticated;

-- The watcher runs every five minutes, and on demand from the scenario and a reassign.
select cron.schedule('pickup-watch', '*/5 * * * *', $$select app.call_function('pickup-watch', '{}'::jsonb)$$);

alter publication supabase_realtime add table
  public.profiles, public.driver_trips, public.market_jobs, public.driver_stays, public.pickup_sites;

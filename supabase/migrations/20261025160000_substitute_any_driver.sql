-- A substitute driver for any driver who cannot get to their car, not only
-- one whose train is late for a dealer pickup: ill, hurt, in hospital, or
-- stranded, with the car still at the dealer or already on the road.
--
-- agent_pickup_context also returns the car's position, and
-- agent_available_drivers searches around the dealer while the car waits
-- for pickup and around the car otherwise.
--
-- apply_suggestion's reassign_driver:
-- - takes the car off the old driver's profile, which takes the delivery out
--   of their driver app live (the app follows its profile), and deletes the
--   car's itinerary, which was built for them;
-- - marks the old driver off work when the move says so (from_driver_availability
--   'off': ill or hurt), else available for other work as before;
-- - sends the new driver to the dealer for a pickup, or to the car's last
--   position when it is already on the road;
-- - sets a car on the road that was stopped for its driver moving again.
--
-- reset_demo also restores the two standby drivers in the north (seed.sql).

create or replace function public.agent_pickup_context(p_vehicle_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', now(),
    'vehicle', jsonb_build_object('id', v.id, 'label', v.label, 'order_ref', v.order_ref, 'status', v.status,
      'lat', v.lat, 'lng', v.lng, 'pickup_eta', v.pickup_eta, 'pickup_in_time', v.pickup_in_time),
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

-- Free drivers near where the substitute has to go, nearest first (straight
-- line; the agent asks Google for real drive times): the dealer while the car
-- waits for pickup, else the car's last position.
create or replace function public.agent_available_drivers(p_vehicle_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with target as (
    select
      case when v.status = 'waiting_pickup' and s.id is not null then s.lat else coalesce(v.lat, s.lat) end as lat,
      case when v.status = 'waiting_pickup' and s.id is not null then s.lng else coalesce(v.lng, s.lng) end as lng
    from public.vehicles v
    left join public.pickup_sites s on s.id = v.pickup_site_id
    where v.id = p_vehicle_id
  )
  select coalesce(jsonb_agg(c order by (c ->> 'km_straight')::numeric), '[]'::jsonb)
  from (
    select jsonb_build_object('driver_id', p.id, 'full_name', p.full_name, 'lat', p.lat, 'lng', p.lng,
      'position_at', p.position_at, 'km_straight', round(app.km(p.lat, p.lng, t.lat, t.lng)::numeric, 1)) as c
    from target t
    join public.profiles p on p.role = 'driver' and p.vehicle_id is null and p.availability = 'available' and p.lat is not null
    where t.lat is not null and app.km(p.lat, p.lng, t.lat, t.lng) < 150
    order by app.km(p.lat, p.lng, t.lat, t.lng)
    limit 5
  ) x
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
  v_free text;
  v_pickup boolean;
  v_lat double precision;
  v_lng double precision;
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
      -- A late driver can take other work; one who is ill or hurt is taken off work.
      v_free := case when s.payload ->> 'from_driver_availability' = 'off' then 'off' else 'available' end;
      select * into site from public.pickup_sites where id = v.pickup_site_id;
      v_pickup := v.status = 'waiting_pickup' and site.id is not null;
      v_lat := case when v_pickup then site.lat else coalesce(v.lat, site.lat) end;
      v_lng := case when v_pickup then site.lng else coalesce(v.lng, site.lng) end;
      -- The driver app shows the car on its driver's profile: clearing it takes
      -- the delivery out of the old driver's app, live.
      update public.profiles set vehicle_id = null, availability = v_free where id = v_from and vehicle_id = v.id;
      update public.profiles set vehicle_id = v.id, availability = 'on_job' where id = np.id;
      update public.assignments set status = 'cancelled' where vehicle_id = v.id and status in ('planned', 'active');
      insert into public.assignments (driver_id, vehicle_id, shift_start, shift_end, status)
      values (np.id, v.id, now(), now() + interval '10 hours', 'active');
      -- The itinerary was the old driver's; the new driver's app builds its own.
      delete from public.itineraries where vehicle_id = v.id;
      update public.vehicles set pickup_eta = null, pickup_in_time = null, pickup_eta_basis = null where id = v.id;
      -- A car on the road stopped because its driver could not go on drives on
      -- with the new driver; nothing else would set it moving again. A car
      -- that needs a check stays as it is.
      if not v_pickup then
        update public.vehicles set status = 'moving' where id = v.id and status in ('stopped', 'offline');
      end if;
      if v_pickup then
        v_body := coalesce(nullif(s.payload ->> 'driver_message', ''),
          format('Control has given you a pickup: %s (%s) at %s, %s.%s', v.label, coalesce(v.order_ref, v.id),
            coalesce(site.name, 'the dealer'), coalesce(site.city, ''),
            case when site.closes_at is not null
              then format(' Keys are handed over in person until %s local time, so please head there now.',
                to_char(site.closes_at at time zone site.timezone, 'HH24:MI'))
              else '' end));
      else
        v_body := coalesce(nullif(s.payload ->> 'driver_message', ''),
          format('Control has given you a car to take over: %s (%s), at its last reported position. Head there now; control will tell you where the keys are.',
            v.label, coalesce(v.order_ref, v.id)));
      end if;
      if v_lat is not null then
        v_body := v_body || ' Navigate: ' || app.maps_link(v_lat, v_lng);
      end if;
      insert into public.messages (to_user, incident_id, body) values (np.id, i.id, v_body);
      if v_from is not null then
        insert into public.messages (to_user, incident_id, body) values (v_from, i.id,
          case
            when v_free = 'off' then
              format('%s is taking over %s, so it is no longer in your app and you do not need to do anything more with it. Look after yourself; control will be in touch.',
                np.full_name, v.label)
            when v_pickup then
              format('%s is taking over the pickup of %s, so you do not need to go to the dealer today. Control will be in touch about tonight and tomorrow.',
                np.full_name, v.label)
            else
              format('%s is taking over %s, so it is no longer in your app. Control will be in touch about what is next for you.',
                np.full_name, v.label)
          end);
      end if;
      if v_pickup then
        perform app.call_function('pickup-watch', jsonb_build_object('vehicle_id', v.id));
      end if;

    when 'book_stay' then
      v_from := (s.payload ->> 'driver_id')::uuid;
      if v_from is null or s.payload ->> 'place_id' is null then
        raise exception 'The stay has no driver or hotel.';
      end if;
      v_nights := coalesce((s.payload ->> 'nights')::integer, 1);
      insert into public.driver_stays (driver_id, place_id, name, address, lat, lng, nights, suggestion_id)
      values (v_from, s.payload ->> 'place_id', s.payload ->> 'name', coalesce(s.payload ->> 'address', ''),
        (s.payload ->> 'lat')::double precision, (s.payload ->> 'lng')::double precision, v_nights, s.id);
      v_body := coalesce(nullif(s.payload ->> 'driver_message', ''),
          format('Control has booked you a room for tonight: %s, %s (%s night%s).',
            s.payload ->> 'name', coalesce(s.payload ->> 'address', ''), v_nights, case when v_nights > 1 then 's' else '' end))
        || ' Pay at the hotel and claim it back with the receipt.'
        || case when s.payload ? 'lat' then ' Navigate: ' || app.maps_link((s.payload ->> 'lat')::double precision, (s.payload ->> 'lng')::double precision) else '' end;
      insert into public.messages (to_user, incident_id, body) values (v_from, i.id, v_body);

    when 'offer_market_job' then
      v_from := (s.payload ->> 'driver_id')::uuid;
      select * into job from public.market_jobs where id = s.payload ->> 'job_id' for update;
      if not found or job.status <> 'open' or v_from is null then
        raise exception 'That job is no longer open.';
      end if;
      update public.market_jobs set status = 'offered', offered_to = v_from, offer_suggestion_id = s.id where id = job.id;
      v_body := coalesce(nullif(s.payload ->> 'driver_message', ''),
          format('A job for tomorrow, if you want it: %s (%s) from %s, %s to %s, pickup %s–%s local. Accept or decline it in the app.',
            job.label, job.order_ref, job.pickup_name, job.pickup_city, job.delivery_city,
            to_char(job.window_start at time zone job.timezone, 'Dy HH24:MI'), to_char(job.window_end at time zone job.timezone, 'HH24:MI')))
        || format(' Fee %s EUR.', to_char(job.fee_cents / 100.0, 'FM999990.00'));
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

create or replace function public.reset_demo() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_seeded_at timestamptz;
  v_messages int;
  v_chat int;
  v_incidents int;
  v_suggestions int;
begin
  perform app.require_role('dispatcher', 'supervisor');

  -- The seed inserts every car in one transaction, so they share its time.
  select max(created_at) into v_seeded_at from public.vehicles;
  if v_seeded_at is null or not exists (select 1 from public.vehicles where id = 'veh-00584') then
    raise exception 'No demo data found: run supabase/seed.sql first.' using errcode = 'P0002';
  end if;

  -- What was sent.
  select count(*) into v_suggestions from public.agent_suggestions;
  delete from public.incidents where true;  -- cascades to agent_suggestions
  get diagnostics v_incidents = row_count;
  delete from public.messages where created_at > v_seeded_at;
  get diagnostics v_messages = row_count;
  update public.messages set read_at = null where read_at is not null;
  delete from public.driver_chat_messages where true;
  get diagnostics v_chat = row_count;

  -- What the agent and the scenarios booked or made up.
  delete from public.hotel_bookings where true;
  update public.hotels set rooms_left = case id when 'hotel-kai' then 4 when 'hotel-priwall' then 2 else 9 end
  where id in ('hotel-kai', 'hotel-priwall', 'hotel-strand');
  delete from public.ferry_bookings where true;
  delete from public.ferry_departures where operator = 'Baltic Link' and from_port = 'travemunde';
  delete from public.driver_stays where true;
  delete from public.driver_trips where true;
  delete from public.market_jobs where true;
  delete from public.itineraries where true;
  update public.pickup_sites set
    closes_at = null,
    opening_hours = '{"mon_fri": "08:00-19:00", "sat": "09:00-14:00", "sun": null}',
    key_handover = 'staff_only'
  where id = 'site-muc-isartal';

  -- The cars, as the seed placed them.
  update public.vehicles v set
    status = s.status::public.vehicle_status, lat = s.lat, lng = s.lng, delay_seconds = s.delay,
    eta = case when s.hours is null then null else now() + make_interval(hours => s.hours, secs => s.delay) end,
    last_seen_at = case when s.hours is null then null else now() - interval '20 seconds' end,
    pickup_site_id = case when v.id = 'veh-01024' then 'site-muc-isartal' else v.pickup_site_id end,
    pickup_eta = null, pickup_in_time = null, pickup_checked_at = null, pickup_eta_basis = null
  from (values
    ('veh-00452', 'moving', 60.65260, 22.55349, 60, 5),
    ('veh-01013', 'moving', 60.31865, 23.68167, 0, 2),
    ('veh-00384', 'waiting_pickup', 61.41458, 23.64210, 0, null),
    ('veh-00366', 'moving', 64.24591, 25.54317, 420, 2),
    ('veh-00806', 'moving', 61.69038, 25.70956, 0, 7),
    ('veh-00145', 'moving', 60.55358, 25.27959, 90, 10),
    ('veh-00917', 'moving', 61.02447, 25.66405, 1500, 8),
    ('veh-00584', 'moving', 54.07402, 11.20455, 180, 1),
    ('veh-00322', 'on_ferry', 57.18985, 18.26937, 2400, 6),
    ('veh-00338', 'moving', 59.97607, 24.13595, 0, 10),
    ('veh-00537', 'moving', 54.60139, 11.30660, 30, 5),
    ('veh-00324', 'moving', 55.66575, 12.55328, 240, 9),
    ('veh-00735', 'moving', 49.84735, 9.64004, 0, 4),
    ('veh-00071', 'moving', 51.31925, 9.48125, 960, 8),
    ('veh-01024', 'waiting_pickup', 48.20637, 11.55466, 0, null)
  ) as s (id, status, lat, lng, delay, hours)
  where v.id = s.id;

  -- Each driver back on their own car, the standby drivers back near Munich and in the north.
  update public.profiles p set
    vehicle_id = d.vehicle_id,
    availability = case when d.vehicle_id is null then 'available' else 'on_job' end,
    lat = d.lat, lng = d.lng,
    position_at = case when d.lat is null then null else now() end
  from (values
    ('10000000-0000-4000-8000-000000000001'::uuid, 'veh-00452', null::double precision, null::double precision),
    ('10000000-0000-4000-8000-000000000002', 'veh-01013', null, null),
    ('10000000-0000-4000-8000-000000000003', 'veh-00384', null, null),
    ('10000000-0000-4000-8000-000000000004', 'veh-00366', null, null),
    ('10000000-0000-4000-8000-000000000005', 'veh-00806', null, null),
    ('10000000-0000-4000-8000-000000000006', 'veh-00145', null, null),
    ('10000000-0000-4000-8000-000000000007', 'veh-00917', null, null),
    ('10000000-0000-4000-8000-000000000008', 'veh-00584', null, null),
    ('10000000-0000-4000-8000-000000000009', 'veh-00322', null, null),
    ('10000000-0000-4000-8000-000000000010', 'veh-00338', null, null),
    ('10000000-0000-4000-8000-000000000011', 'veh-00537', null, null),
    ('10000000-0000-4000-8000-000000000012', 'veh-00324', null, null),
    ('10000000-0000-4000-8000-000000000013', 'veh-00735', null, null),
    ('10000000-0000-4000-8000-000000000014', 'veh-00071', null, null),
    ('10000000-0000-4000-8000-000000000015', 'veh-01024', null, null),
    ('10000000-0000-4000-8000-000000000016', null, 48.4029, 11.7488),   -- Freising
    ('10000000-0000-4000-8000-000000000017', null, 48.3705, 10.8978),   -- Augsburg
    ('10000000-0000-4000-8000-000000000018', null, 48.7665, 11.4258),   -- Ingolstadt
    ('10000000-0000-4000-8000-000000000019', null, 53.8655, 10.6866),   -- Lübeck
    ('10000000-0000-4000-8000-000000000020', null, 53.5511, 9.9937)     -- Hamburg
  ) as d (id, vehicle_id, lat, lng)
  where p.id = d.id and p.role = 'driver';

  delete from public.assignments where vehicle_id in (
    'veh-00452', 'veh-01013', 'veh-00384', 'veh-00366', 'veh-00806', 'veh-00145', 'veh-00917', 'veh-00584',
    'veh-00322', 'veh-00338', 'veh-00537', 'veh-00324', 'veh-00735', 'veh-00071', 'veh-01024');
  insert into public.assignments (driver_id, vehicle_id, shift_start, shift_end, status)
  select p.id, p.vehicle_id, now() - interval '2 hours', now() + interval '10 hours',
    case when v.status = 'waiting_pickup' then 'planned' else 'active' end
  from public.profiles p join public.vehicles v on v.id = p.vehicle_id
  where p.role = 'driver' and p.id::text like '10000000-0000-4000-8000-0000000000%';

  perform app.audit('demo.reset', jsonb_build_object(
    'messages', v_messages, 'chat', v_chat, 'incidents', v_incidents, 'suggestions', v_suggestions));
  return jsonb_build_object('messages', v_messages, 'chat', v_chat, 'incidents', v_incidents, 'suggestions', v_suggestions);
end
$$;
revoke all on function public.reset_demo() from public, anon;
grant execute on function public.reset_demo() to authenticated;

-- Requests through the API run with pg-safeupdate, which refuses an UPDATE
-- or DELETE without a WHERE clause: the hotel rooms reset had none. Every
-- statement in reset_demo now has one.

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

  -- Each driver back on their own car, the standby drivers back near Munich.
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
    ('10000000-0000-4000-8000-000000000018', null, 48.7665, 11.4258)    -- Ingolstadt
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

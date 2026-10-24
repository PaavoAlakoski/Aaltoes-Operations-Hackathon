-- Each ferry scenario run also clears the messages of the run before, so the
-- agent sees the same world every time.

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

  -- The previous run's messages go too, or the agent reads them as history
  -- and proposes correcting times that no longer apply.
  delete from public.messages where to_vehicle = 'veh-00584'
    and incident_id in (select id from public.incidents where vehicle_id = 'veh-00584' and description like '[Simulation]%');
  delete from public.incidents where vehicle_id = 'veh-00584' and description like '[Simulation]%';
  delete from public.hotel_bookings where hotel_id in (select id from public.hotels where port_id = 'travemunde');
  update public.hotels set rooms_left = case id when 'hotel-kai' then 4 when 'hotel-priwall' then 2 else 9 end
  where port_id = 'travemunde';
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

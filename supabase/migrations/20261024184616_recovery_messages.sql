-- Driver messages for the recovery moves said everything twice: the
-- standard text and then the agent's own wording. When the agent wrote a
-- message, it now replaces the standard text; the Maps link, the receipt
-- note and the fee are still added, because those come from the data.

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
      v_body := coalesce(nullif(s.payload ->> 'driver_message', ''),
        format('Control has given you a pickup: %s (%s) at %s, %s.%s', v.label, coalesce(v.order_ref, v.id),
          coalesce(site.name, 'the dealer'), coalesce(site.city, ''),
          case when site.closes_at is not null
            then format(' Keys are handed over in person until %s local time, so please head there now.',
              to_char(site.closes_at at time zone site.timezone, 'HH24:MI'))
            else '' end))
        || ' Navigate: ' || app.maps_link(coalesce(site.lat, v.lat), coalesce(site.lng, v.lng));
      insert into public.messages (to_user, incident_id, body) values (np.id, i.id, v_body);
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

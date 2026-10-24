-- The clear button touches nothing that came with the database. Everything
-- the seed loads (cars, users, the two starting messages) shares the seed's
-- timestamp; created_at on messages and incidents is set by triggers, so a
-- client cannot backdate a row. The function only deletes rows created after
-- that moment, and only these:
--   incidents  reported by a signed-in person (a driver, or control: this
--              includes the simulated ferry jam), with the agent's proposals.
--              Incidents the system raises on its own (tracking gaps) stay.
--   messages   written by a person in an app, or the agent's replies.
--   hotel      rooms the agent booked go back on sale one by one; nothing
--              is reset to fixed numbers.
-- The snapshot tables (records, decisions, autonomy), cars, corridors, users,
-- ferries and the audit log are never touched.

create or replace function public.clear_live_activity() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_seeded_at timestamptz;
  v_messages int;
  v_incidents int;
  v_suggestions int;
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

  with gone as (
    delete from public.hotel_bookings where created_at > v_seeded_at returning hotel_id
  ), per_hotel as (
    select hotel_id, count(*) as n from gone group by hotel_id
  )
  update public.hotels h set rooms_left = h.rooms_left + p.n
  from per_hotel p where h.id = p.hotel_id;

  perform app.audit('live.cleared', jsonb_build_object(
    'since', v_seeded_at, 'messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions));
  return jsonb_build_object('messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions);
end
$$;

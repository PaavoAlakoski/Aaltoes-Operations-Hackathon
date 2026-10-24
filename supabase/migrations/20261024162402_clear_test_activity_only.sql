-- The clear button removes only what was sent while testing:
--   messages  everything a person wrote in an app, and every agent reply.
--             The two starting messages from supabase/seed.sql stay.
--   incidents everything reported by a driver or by control (including the
--             simulated ferry jam), and with them the agent's proposals.
--             Incidents the system raises on its own (tracking gaps) stay.
-- Hotel rooms the agent booked are freed, as before.

create or replace function public.clear_live_activity() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_messages int;
  v_incidents int;
  v_suggestions int;
begin
  perform app.require_role('dispatcher', 'supervisor');

  delete from public.messages
  where body not in (
    -- Keep in step with the "little history" in supabase/seed.sql.
    'The ferry from Vuosaari is running about 40 minutes late this morning. Plan your arrival at the terminal for that.',
    'The delivery site in Turku closes at 17:00. Call the desk if you will be later.'
  );
  get diagnostics v_messages = row_count;

  select count(*) into v_suggestions from public.agent_suggestions s
  join public.incidents i on i.id = s.incident_id
  where i.source in ('driver', 'control');
  delete from public.incidents where source in ('driver', 'control');  -- cascades to agent_suggestions
  get diagnostics v_incidents = row_count;

  delete from public.hotel_bookings where true;
  update public.hotels set rooms_left = case id when 'hotel-kai' then 4 when 'hotel-priwall' then 2 else 9 end
  where port_id = 'travemunde';

  perform app.audit('live.cleared', jsonb_build_object(
    'messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions));
  return jsonb_build_object('messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions);
end
$$;

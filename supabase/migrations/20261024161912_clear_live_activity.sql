-- Clears everything people and the agent have said and asked for in live
-- operations: every message, every incident (and with it every agent
-- proposal) and the hotel rooms the agent booked. The cars,
-- corridors, users and the snapshot tables stay. Any staff member may run it;
-- it is for resetting the room between demos.

create or replace function public.clear_live_activity() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_messages int;
  v_incidents int;
  v_suggestions int;
begin
  perform app.require_role('dispatcher', 'supervisor');

  select count(*) into v_suggestions from public.agent_suggestions;
  delete from public.messages where true;
  get diagnostics v_messages = row_count;
  delete from public.incidents where true;  -- cascades to agent_suggestions
  get diagnostics v_incidents = row_count;

  delete from public.hotel_bookings where true;
  update public.hotels set rooms_left = case id when 'hotel-kai' then 4 when 'hotel-priwall' then 2 else 9 end
  where port_id = 'travemunde';
  -- Ferry rebookings overwrite the original booking, so there is nothing to
  -- go back to; the ferry scenario resets its own car's booking each run.

  perform app.audit('live.cleared', jsonb_build_object(
    'messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions));
  return jsonb_build_object('messages', v_messages, 'incidents', v_incidents, 'suggestions', v_suggestions);
end
$$;

revoke all on function public.clear_live_activity() from public, anon;
grant execute on function public.clear_live_activity() to authenticated;

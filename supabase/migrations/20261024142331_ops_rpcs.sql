-- Privileged writes. Each function checks the caller's role from profiles
-- (not the token, which can be up to an hour old), takes a row lock where two
-- people could race, and writes the audit log in the same transaction.
-- Errors: 42501 forbidden (403), P0002 not found (404), PT409 conflict (409),
-- 22023 bad input (400).

create or replace function app.audit(p_action text, p_details jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, actor_type, action, details)
  values (auth.uid(), case when auth.uid() is null then 'system' else 'user' end::public.actor_type, p_action, p_details)
$$;
revoke all on function app.audit(text, jsonb) from public, anon, authenticated;

create or replace function app.require_role(variadic p_roles public.app_role[]) returns public.app_role
language plpgsql stable security definer set search_path = '' as $$
declare v_role public.app_role := app.role_from_db();
begin
  if v_role is null or not (v_role = any (p_roles)) then
    raise exception 'Only % may do this.', array_to_string(p_roles, ' or ') using errcode = '42501';
  end if;
  return v_role;
end
$$;

-- Driver ------------------------------------------------------------------------

-- Stores the latest position of the caller's car. Live movement goes over the
-- corridor's Broadcast channel; this only keeps the last known point, so
-- it saves at most one position per 12 seconds and reports whether it did.
create or replace function public.report_position(
  p_lat double precision,
  p_lng double precision,
  p_delay_seconds integer default null,
  p_eta timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_vehicle text;
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

  select last_seen_at into v_last from public.vehicles where id = v_vehicle for update;
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
  return jsonb_build_object('saved', true, 'vehicle_id', v_vehicle, 'next_at', now() + interval '12 seconds');
end
$$;

-- Marks a message to the caller (or their car) as read. Corridor-wide
-- messages have no single reader and are not marked.
create or replace function public.mark_message_read(p_message_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.messages set read_at = coalesce(read_at, now())
  where id = p_message_id
    and (to_user = auth.uid() or (to_vehicle is not null and to_vehicle = (select vehicle_id from public.profiles where id = auth.uid())));
  if not found then
    raise exception 'No such message for you.' using errcode = 'P0002';
  end if;
end
$$;

-- Dispatcher and supervisor -----------------------------------------------------

create or replace function public.acknowledge_incident(p_incident_id uuid) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare v_row public.incidents;
begin
  perform app.require_role('dispatcher', 'supervisor');
  select * into v_row from public.incidents where id = p_incident_id for update;
  if not found then
    raise exception 'No such incident.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'open' then
    raise exception 'Already % by %.', v_row.status,
      coalesce((select full_name from public.profiles where id = coalesce(v_row.acknowledged_by, v_row.resolved_by)), 'someone')
      using errcode = 'PT409';
  end if;

  update public.incidents set
    status = 'acknowledged',
    acknowledged_at = now(),
    acknowledged_by = auth.uid(),
    assigned_to = coalesce(assigned_to, auth.uid())
  where id = p_incident_id
  returning * into v_row;
  perform app.audit('incident.acknowledge', jsonb_build_object('incident_id', p_incident_id));
  return v_row;
end
$$;

create or replace function public.assign_incident(p_incident_id uuid, p_assignee uuid) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare v_row public.incidents;
begin
  perform app.require_role('dispatcher', 'supervisor');
  if p_assignee is not null and not app.is_staff_user(p_assignee) then
    raise exception 'Incidents go to a dispatcher or a supervisor.' using errcode = '22023';
  end if;
  update public.incidents set assigned_to = p_assignee
  where id = p_incident_id and status <> 'resolved'
  returning * into v_row;
  if not found then
    raise exception 'No open incident with that id.' using errcode = 'P0002';
  end if;
  perform app.audit('incident.assign', jsonb_build_object('incident_id', p_incident_id, 'assignee', p_assignee));
  return v_row;
end
$$;

create or replace function public.resolve_incident(p_incident_id uuid, p_note text default null) returns public.incidents
language plpgsql security definer set search_path = '' as $$
declare v_row public.incidents;
begin
  perform app.require_role('dispatcher', 'supervisor');
  select * into v_row from public.incidents where id = p_incident_id for update;
  if not found then
    raise exception 'No such incident.' using errcode = 'P0002';
  end if;
  if v_row.status = 'resolved' then
    raise exception 'Already resolved.' using errcode = 'PT409';
  end if;
  update public.incidents set
    status = 'resolved',
    resolved_at = now(),
    resolved_by = auth.uid(),
    -- Resolving straight from open still counts as the first response.
    acknowledged_at = coalesce(acknowledged_at, now()),
    acknowledged_by = coalesce(acknowledged_by, auth.uid())
  where id = p_incident_id
  returning * into v_row;
  -- Suggestions nobody decided on are moot once the incident is closed.
  update public.agent_suggestions set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
    decision_note = 'Incident resolved'
  where incident_id = p_incident_id and status = 'pending';
  perform app.audit('incident.resolve', jsonb_build_object('incident_id', p_incident_id, 'note', p_note));
  return v_row;
end
$$;

-- Approve or reject what the agent proposed. Approval only records the
-- decision; the execute-suggestion function carries it out (see the agent
-- migration), so a person always sits between the model and any action.
create or replace function public.decide_suggestion(
  p_suggestion_id uuid,
  p_decision text,
  p_note text default null
) returns public.agent_suggestions
language plpgsql security definer set search_path = '' as $$
declare v_row public.agent_suggestions;
begin
  perform app.require_role('dispatcher', 'supervisor');
  if p_decision not in ('approve', 'reject') then
    raise exception 'Decide approve or reject.' using errcode = '22023';
  end if;
  if p_decision = 'reject' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Say why you reject it.' using errcode = '22023';
  end if;

  select * into v_row from public.agent_suggestions where id = p_suggestion_id for update;
  if not found then
    raise exception 'No such suggestion.' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'Already % by %.', v_row.status,
      coalesce((select full_name from public.profiles where id = v_row.decided_by), 'someone')
      using errcode = 'PT409';
  end if;
  -- Supervisors only for actions a dispatcher could not take by hand.
  if p_decision = 'approve' and v_row.suggestion_type = 'set_vehicle_status' then
    perform app.require_role('supervisor');
  end if;

  update public.agent_suggestions set
    status = case when p_decision = 'approve' then 'approved' else 'rejected' end::public.suggestion_status,
    decided_by = auth.uid(),
    decided_at = now(),
    decision_note = nullif(btrim(p_note), '')
  where id = p_suggestion_id
  returning * into v_row;
  perform app.audit('suggestion.' || p_decision, jsonb_build_object(
    'suggestion_id', p_suggestion_id, 'incident_id', v_row.incident_id,
    'suggestion_type', v_row.suggestion_type, 'note', p_note));
  return v_row;
end
$$;

-- Supervisor ----------------------------------------------------------------------

create or replace function public.set_vehicle_status(
  p_vehicle_id text,
  p_status public.vehicle_status,
  p_reason text default null
) returns public.vehicles
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.vehicles;
  v_from public.vehicle_status;
begin
  perform app.require_role('supervisor');
  select status into v_from from public.vehicles where id = p_vehicle_id for update;
  if not found then
    raise exception 'No such car.' using errcode = 'P0002';
  end if;
  update public.vehicles set status = p_status where id = p_vehicle_id returning * into v_row;
  perform app.audit('vehicle.set_status', jsonb_build_object(
    'vehicle_id', p_vehicle_id, 'from', v_from, 'to', p_status, 'reason', p_reason));
  return v_row;
end
$$;

-- User management: give someone a role and, for a driver, a car.
create or replace function public.set_user_role(
  p_user_id uuid,
  p_role public.app_role,
  p_vehicle_id text default null
) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare v_row public.profiles;
begin
  perform app.require_role('supervisor');
  if p_user_id = auth.uid() and p_role <> 'supervisor' then
    raise exception 'Ask another supervisor to change your own role.' using errcode = '22023';
  end if;
  if p_role <> 'driver' and p_vehicle_id is not null then
    raise exception 'Only drivers are put on a car.' using errcode = '22023';
  end if;
  update public.profiles set role = p_role, vehicle_id = p_vehicle_id
  where id = p_user_id
  returning * into v_row;
  if not found then
    raise exception 'No such user.' using errcode = 'P0002';
  end if;
  perform app.audit('user.set_role', jsonb_build_object('user_id', p_user_id, 'role', p_role, 'vehicle_id', p_vehicle_id));
  return v_row;
end
$$;

-- Only signed-in users may call these; each checks the role itself.
revoke execute on function
  public.report_position(double precision, double precision, integer, timestamptz),
  public.mark_message_read(uuid),
  public.acknowledge_incident(uuid),
  public.assign_incident(uuid, uuid),
  public.resolve_incident(uuid, text),
  public.decide_suggestion(uuid, text, text),
  public.set_vehicle_status(text, public.vehicle_status, text),
  public.set_user_role(uuid, public.app_role, text)
  from public, anon;
grant execute on function
  public.report_position(double precision, double precision, integer, timestamptz),
  public.mark_message_read(uuid),
  public.acknowledge_incident(uuid),
  public.assign_incident(uuid, uuid),
  public.resolve_incident(uuid, text),
  public.decide_suggestion(uuid, text, text),
  public.set_vehicle_status(text, public.vehicle_status, text),
  public.set_user_role(uuid, public.app_role, text)
  to authenticated;

-- KPIs for the control room strip. security_invoker, so a driver who queries
-- it sees figures over their own car only.
create or replace view public.ops_kpis with (security_invoker = true) as
select
  (select round(100.0 * count(*) filter (where delay_seconds <= 300) / nullif(count(*), 0), 1)
     from public.vehicles where status in ('moving', 'on_ferry', 'stopped', 'needs_check')) as on_time_pct,
  (select count(*) from public.incidents where status <> 'resolved')::int as open_incidents,
  (select count(*) from public.agent_suggestions where status = 'pending')::int as pending_suggestions,
  (select round(extract(epoch from avg(acknowledged_at - created_at)))::int
     from public.incidents where acknowledged_at is not null and created_at > now() - interval '24 hours') as avg_ack_seconds;
grant select on public.ops_kpis to authenticated;
revoke all on public.ops_kpis from anon;

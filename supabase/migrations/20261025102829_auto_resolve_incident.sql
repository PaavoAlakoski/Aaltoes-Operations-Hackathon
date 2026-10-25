-- An incident closes itself once its recovery is done: every agent move is
-- settled, at least one was carried out, and a person decided at least one
-- (moves the agent took on its own never close an incident nobody has seen).
-- A failed move keeps it open for a person. Additive only.

create or replace function app.auto_resolve_incident() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status not in ('executed', 'rejected') or new.status = old.status then
    return null;
  end if;
  if exists (select 1 from public.agent_suggestions
             where incident_id = new.incident_id and status in ('pending', 'approved', 'failed'))
     or not exists (select 1 from public.agent_suggestions
                    where incident_id = new.incident_id and status = 'executed')
     or not exists (select 1 from public.agent_suggestions
                    where incident_id = new.incident_id and decided_by is not null) then
    return null;
  end if;
  update public.incidents set
    status = 'resolved',
    resolved_at = now(),
    acknowledged_at = coalesce(acknowledged_at, now())
  where id = new.incident_id and status <> 'resolved';
  if found then
    perform app.audit('incident.auto_resolve', jsonb_build_object('incident_id', new.incident_id, 'last_suggestion_id', new.id));
  end if;
  return null;
end
$$;
revoke all on function app.auto_resolve_incident() from public, anon, authenticated;

create trigger auto_resolve_incident after update of status on public.agent_suggestions
  for each row execute function app.auto_resolve_incident();

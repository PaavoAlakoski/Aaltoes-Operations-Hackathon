-- Paid work (Google Maps, the OpenRouter agent) only while someone has an app
-- open. The control room and the driver app call touch_presence() every
-- minute while their tab is visible; the simulator never does, so it does not
-- count. With nobody there, the pickup check and agent triage stay quiet.

create table app.site_presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  seen_at timestamptz not null default now()
);

create or replace function public.touch_presence() returns void
language sql security definer set search_path = '' as $$
  insert into app.site_presence (user_id, seen_at)
  select auth.uid(), now() where auth.uid() is not null
  on conflict (user_id) do update set seen_at = excluded.seen_at
$$;
revoke all on function public.touch_presence() from public, anon;
grant execute on function public.touch_presence() to authenticated;

-- Three missed heartbeats and the room counts as empty.
create or replace function app.someone_active() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.site_presence where seen_at > now() - interval '3 minutes')
$$;
revoke all on function app.someone_active() from public, anon, authenticated;

-- Every new incident goes to the agent, except ones the agent raised itself
-- and ones raised while nobody is using the apps.
create or replace function app.on_incident_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.source <> 'agent' and app.someone_active() then
    perform app.call_function('agent-triage', jsonb_build_object('incident_id', new.id));
  end if;
  return null;
end
$$;

-- Every 20 minutes instead of 5, and only while someone is there.
select cron.schedule('pickup-watch', '*/20 * * * *',
  $$select app.call_function('pickup-watch', '{}'::jsonb) where app.someone_active()$$);

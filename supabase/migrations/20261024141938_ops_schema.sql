-- The live operations backend shared by the control room, the driver app and
-- the helper agent. Additive: the snapshot tables (records, decisions,
-- autonomy) are not touched.
--
-- Vocabulary. A corridor is a route cars are driven along (the brief's
-- "line"). A vehicle is the car being delivered, not a company van. An
-- assignment puts a driver on one car for a shift.

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

create type public.app_role as enum ('driver', 'dispatcher', 'supervisor');
create type public.vehicle_status as enum (
  'waiting_pickup', 'moving', 'stopped', 'on_ferry', 'needs_check', 'delivered', 'offline'
);
create type public.incident_source as enum ('driver', 'control', 'agent', 'system');
create type public.incident_severity as enum ('low', 'medium', 'high', 'critical');
create type public.incident_status as enum ('open', 'acknowledged', 'resolved');
create type public.suggestion_status as enum ('pending', 'approved', 'rejected', 'executed', 'failed');
create type public.actor_type as enum ('user', 'agent', 'system');

create or replace function app.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Tables ---------------------------------------------------------------------

create table public.corridors (
  id text primary key,
  name text not null,
  color text not null,
  -- Waypoints as [lng, lat] pairs, in driving order.
  path jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.vehicles (
  id text primary key,                       -- the dataset's car id, e.g. veh-00004
  corridor_id text not null references public.corridors (id),
  order_id text null,                        -- ord-00004, matches the snapshot in records
  order_ref text null,                       -- CD-420004, what people say on the phone
  label text not null,                       -- "Porsche Taycan"
  registration text null,
  status public.vehicle_status not null default 'waiting_pickup',
  lat double precision null check (lat between -90 and 90),
  lng double precision null check (lng between -180 and 180),
  -- Positive means behind the promised delivery time.
  delay_seconds integer not null default 0,
  eta timestamptz null,
  last_seen_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index vehicles_corridor_idx on public.vehicles (corridor_id);
create index vehicles_moving_last_seen_idx on public.vehicles (last_seen_at) where status = 'moving';

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  role public.app_role not null default 'driver',
  vehicle_id text null references public.vehicles (id) on delete set null,
  driver_ref text null,                      -- drv-026 in the dataset
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_vehicle_idx on public.profiles (vehicle_id);
create index profiles_role_idx on public.profiles (role);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.profiles (id) on delete cascade,
  vehicle_id text not null references public.vehicles (id) on delete cascade,
  shift_start timestamptz not null,
  shift_end timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'active', 'done', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (shift_end > shift_start)
);
create index assignments_driver_idx on public.assignments (driver_id, shift_start desc);
create index assignments_vehicle_idx on public.assignments (vehicle_id, shift_start desc);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  vehicle_id text not null references public.vehicles (id) on delete cascade,
  reported_by uuid null references public.profiles (id) on delete set null,
  source public.incident_source not null,
  kind text not null check (kind in (
    'breakdown', 'accident', 'delay', 'car_not_ready', 'documents',
    'ferry', 'tracking_gap', 'damage', 'other'
  )),
  severity public.incident_severity not null default 'medium',
  description text not null default '' check (length(description) <= 2000),
  status public.incident_status not null default 'open',
  assigned_to uuid null references public.profiles (id) on delete set null,
  acknowledged_at timestamptz null,
  acknowledged_by uuid null references public.profiles (id) on delete set null,
  resolved_at timestamptz null,
  resolved_by uuid null references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index incidents_queue_idx on public.incidents (status, created_at desc);
create index incidents_vehicle_idx on public.incidents (vehicle_id, created_at desc);
create index incidents_assigned_idx on public.incidents (assigned_to) where status <> 'resolved';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  from_user uuid null references public.profiles (id) on delete set null,  -- null: sent by the agent or the system
  to_user uuid null references public.profiles (id) on delete cascade,
  to_vehicle text null references public.vehicles (id) on delete cascade,
  to_corridor text null references public.corridors (id) on delete cascade,
  incident_id uuid null references public.incidents (id) on delete set null,
  body text not null check (length(btrim(body)) between 1 and 2000),
  read_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one addressee.
  check (num_nonnulls(to_user, to_vehicle, to_corridor) = 1)
);
create index messages_to_user_idx on public.messages (to_user, created_at desc) where to_user is not null;
create index messages_to_vehicle_idx on public.messages (to_vehicle, created_at desc) where to_vehicle is not null;
create index messages_to_corridor_idx on public.messages (to_corridor, created_at desc) where to_corridor is not null;
create index messages_from_idx on public.messages (from_user, created_at desc);
create index messages_created_idx on public.messages (created_at desc);

create table public.agent_suggestions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  suggestion_type text not null check (suggestion_type in (
    'message_vehicle', 'message_corridor', 'set_vehicle_status', 'escalate_incident'
  )),
  payload jsonb not null default '{}'::jsonb,
  rationale text not null,
  model text null,
  status public.suggestion_status not null default 'pending',
  decided_by uuid null references public.profiles (id) on delete set null,
  decided_at timestamptz null,
  decision_note text null,
  executed_at timestamptz null,
  error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agent_suggestions_incident_idx on public.agent_suggestions (incident_id);
create index agent_suggestions_pending_idx on public.agent_suggestions (created_at desc) where status = 'pending';

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid null,                        -- a user, or null for the agent and the system
  actor_type public.actor_type not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['corridors', 'vehicles', 'profiles', 'assignments', 'incidents', 'messages', 'agent_suggestions'] loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function app.set_updated_at()', t);
  end loop;
end
$$;

-- Who is asking --------------------------------------------------------------
-- RLS reads the claims the access token hook puts in the JWT, and falls back
-- to profiles when a token was minted before the hook was turned on. The
-- privileged RPCs ignore claims and read profiles, so a demotion takes
-- effect at once there and at the next token refresh everywhere else.

create or replace function app.role_from_db() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function app.user_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select coalesce(
    nullif(auth.jwt() ->> 'app_role', '')::public.app_role,
    (select role from public.profiles where id = auth.uid())
  )
$$;

create or replace function app.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.user_role() in ('dispatcher', 'supervisor'), false)
$$;

create or replace function app.my_vehicle() returns text
language sql stable security definer set search_path = '' as $$
  select case
    when auth.jwt() ? 'vehicle_id' then nullif(auth.jwt() ->> 'vehicle_id', '')
    else (select vehicle_id from public.profiles where id = auth.uid())
  end
$$;

create or replace function app.my_corridor() returns text
language sql stable security definer set search_path = '' as $$
  select corridor_id from public.vehicles where id = app.my_vehicle()
$$;

-- Whether someone else is staff. Drivers cannot read staff profiles, so the
-- reply policy needs this to check the addressee.
create or replace function app.is_staff_user(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = p_user and role in ('dispatcher', 'supervisor'))
$$;

revoke all on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated, service_role;

-- Access token hook ----------------------------------------------------------
-- Turn on in Authentication > Hooks (config.toml does it for the local stack).

create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_profile record;
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
  select role, vehicle_id into v_profile
  from public.profiles where id = (event ->> 'user_id')::uuid;

  if found then
    v_claims := v_claims
      || jsonb_build_object('app_role', v_profile.role::text)
      || jsonb_build_object('vehicle_id', v_profile.vehicle_id);
  else
    v_claims := v_claims || jsonb_build_object('app_role', null, 'vehicle_id', null);
  end if;
  return jsonb_set(event, '{claims}', v_claims);
end
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on public.profiles to supabase_auth_admin;

-- A new sign-up gets a driver profile with no car, which can see nothing but
-- itself. Only a supervisor can give it a role or a car (set_user_role).
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1), ''))
  on conflict (id) do nothing;
  return new;
end
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- Incidents and messages stamp who sent them, whatever the client claims.
create or replace function app.stamp_incident() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.reported_by := auth.uid();
    new.source := case when app.user_role() = 'driver' then 'driver' else 'control' end::public.incident_source;
    new.status := 'open';
    new.assigned_to := null;
    new.acknowledged_at := null; new.acknowledged_by := null;
    new.resolved_at := null; new.resolved_by := null;
  end if;
  new.created_at := now();
  return new;
end
$$;
create trigger stamp_incident before insert on public.incidents
  for each row execute function app.stamp_incident();

create or replace function app.stamp_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.from_user := auth.uid();
    new.read_at := null;
  end if;
  new.created_at := now();
  return new;
end
$$;
create trigger stamp_message before insert on public.messages
  for each row execute function app.stamp_message();

-- Row-level security -----------------------------------------------------------
-- Nothing is open to anon. Authenticated users get table privileges only where
-- a policy can use them; every other write goes through an RPC.

alter table public.corridors enable row level security;
alter table public.vehicles enable row level security;
alter table public.profiles enable row level security;
alter table public.assignments enable row level security;
alter table public.incidents enable row level security;
alter table public.messages enable row level security;
alter table public.agent_suggestions enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.corridors, public.vehicles, public.profiles, public.assignments,
  public.incidents, public.messages, public.agent_suggestions, public.audit_log
  from anon, authenticated;
grant select on public.corridors, public.vehicles, public.profiles, public.assignments,
  public.incidents, public.messages, public.agent_suggestions, public.audit_log
  to authenticated;
grant insert (vehicle_id, kind, severity, description) on public.incidents to authenticated;
grant insert (to_user, to_vehicle, to_corridor, incident_id, body) on public.messages to authenticated;

-- Corridors are the route network, not operational detail: anyone signed in.
create policy "signed-in users read corridors" on public.corridors
  for select to authenticated using (true);

-- Drivers see their own car only. They have no need for other cars' positions
-- to drive theirs, and those positions reveal other drivers' whereabouts.
create policy "staff read all vehicles" on public.vehicles
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their own vehicle" on public.vehicles
  for select to authenticated using (id = (select app.my_vehicle()));

create policy "staff read all profiles" on public.profiles
  for select to authenticated using ((select app.is_staff()));
create policy "users read their own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "auth hook reads profiles" on public.profiles
  for select to supabase_auth_admin using (true);

create policy "staff read all assignments" on public.assignments
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their own assignments" on public.assignments
  for select to authenticated using (driver_id = (select auth.uid()));

-- Drivers see incidents on their own car, so they know a report arrived and
-- what control did with it.
create policy "staff read all incidents" on public.incidents
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read incidents on their vehicle" on public.incidents
  for select to authenticated using (vehicle_id = (select app.my_vehicle()));
create policy "staff report incidents" on public.incidents
  for insert to authenticated with check ((select app.is_staff()));
create policy "drivers report incidents on their vehicle" on public.incidents
  for insert to authenticated with check (
    (select app.user_role()) = 'driver' and vehicle_id = (select app.my_vehicle())
  );

create policy "staff read all messages" on public.messages
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read messages to them, their car or their corridor" on public.messages
  for select to authenticated using (
    to_user = (select auth.uid())
    or from_user = (select auth.uid())
    or to_vehicle = (select app.my_vehicle())
    or to_corridor = (select app.my_corridor())
  );
create policy "staff send messages" on public.messages
  for insert to authenticated with check ((select app.is_staff()));
-- A driver on a car may write back to a member of staff, and to no one else.
create policy "drivers reply to staff" on public.messages
  for insert to authenticated with check (
    (select app.user_role()) = 'driver'
    and (select app.my_vehicle()) is not null
    and to_user is not null
    and app.is_staff_user(to_user)
  );

create policy "staff read agent suggestions" on public.agent_suggestions
  for select to authenticated using ((select app.is_staff()));

create policy "staff read the audit log" on public.audit_log
  for select to authenticated using ((select app.is_staff()));

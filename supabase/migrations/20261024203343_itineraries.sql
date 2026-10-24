-- A driver's whole job as legs (trains, flight, pickup, drives, ferry,
-- handover, the way home), built by the build-itinerary function from the
-- dataset and the live ferry booking. Road legs come from Google once and are
-- kept in route_cache, so opening the app again costs nothing.

create table public.itineraries (
  vehicle_id text primary key references public.vehicles (id) on delete cascade,
  driver_id uuid not null references public.profiles (id) on delete cascade,
  legs jsonb not null,
  -- Dataset times are moved by this much so the job is happening now.
  shift_seconds integer not null,
  ferry_departure_id uuid references public.ferry_departures (id) on delete set null,
  built_at timestamptz not null default now()
);
alter table public.itineraries enable row level security;
grant select on public.itineraries to authenticated;
create policy "staff read itineraries" on public.itineraries
  for select to authenticated using ((select app.is_staff()));
create policy "drivers read their own itinerary" on public.itineraries
  for select to authenticated using (driver_id = (select auth.uid()));

-- Server only: RLS with no policies, so only the service role reads or writes it.
create table public.route_cache (
  key text primary key,
  path jsonb not null,
  km double precision not null,
  minutes integer not null,
  source text not null check (source in ('google', 'estimate')),
  fetched_at timestamptz not null default now()
);
alter table public.route_cache enable row level security;

alter publication supabase_realtime add table public.itineraries;

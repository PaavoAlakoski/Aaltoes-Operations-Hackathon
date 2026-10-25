-- Cars drive on their schedule without anyone running the simulator. Every
-- 20 seconds each car that is driving (moving, on the ferry, or gone offline)
-- is put where its itinerary says it is now: along the leg's road between
-- departure and arrival, stopped 45 minutes after every 4½ hours at the wheel,
-- waiting at the port, crossing on the ferry. The same rule as
-- scheduledPosition in packages/shared/src/schedule.ts. A car whose position
-- a driver app or the simulator sent in the last minute is left to them.
-- The agent's own records (audit_log) go out over Realtime too, so the control
-- room can show what the agent concluded when it made no proposal. Additive only.

create table app.schedule_fixes (
  vehicle_id text primary key references public.vehicles (id) on delete cascade,
  sent_at timestamptz not null
);

create or replace function app.km_between(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision language sql immutable as $$
  select 6371 * 2 * asin(sqrt(power(sin(radians(b_lat - a_lat) / 2), 2)
    + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)))
$$;

-- How far along a drive or ferry leg the car is at p_at, 0..1 (legFraction).
create or replace function app.leg_fraction(p_leg jsonb, p_at timestamptz) returns double precision
language plpgsql stable as $$
declare
  v_start timestamptz := (p_leg ->> 'depart_at')::timestamptz;
  v_span double precision := greatest(extract(epoch from (p_leg ->> 'arrive_at')::timestamptz - v_start), 60);
  v_t double precision := extract(epoch from p_at - v_start);
  v_minutes double precision := nullif((p_leg ->> 'minutes')::double precision, 0);
  v_breaks integer;
  v_driving double precision;
  v_block double precision;
  v_driven double precision := 0;
  v_clock double precision := 0;
  v_run double precision;
begin
  if v_t <= 0 then return 0; end if;
  if v_t >= v_span then return 1; end if;
  if p_leg ->> 'kind' <> 'drive' or v_minutes is null then return v_t / v_span; end if;
  -- The breaks take fixed time; the driving fills the rest.
  v_breaks := floor(v_minutes / 270);
  v_driving := greatest(v_span - v_breaks * 45 * 60, 60);
  v_block := 270 * 60 * (v_driving / (v_minutes * 60));
  for i in 0..v_breaks loop
    v_run := case when i < v_breaks then v_block else v_driving - v_driven end;
    if v_t <= v_clock + v_run then return least((v_driven + v_t - v_clock) / v_driving, 1); end if;
    v_driven := v_driven + v_run;
    v_clock := v_clock + v_run;
    if i < v_breaks then
      if v_t <= v_clock + 45 * 60 then return v_driven / v_driving; end if;
      v_clock := v_clock + 45 * 60;
    end if;
  end loop;
  return 1;
end
$$;

-- The point a fraction of the way along a [lng, lat] path (pointAlong).
create or replace function app.point_along(p_path jsonb, p_fraction double precision, out lat double precision, out lng double precision)
language sql stable as $$
  with pts as (
    select ord, (e ->> 0)::double precision x, (e ->> 1)::double precision y
    from jsonb_array_elements(p_path) with ordinality t (e, ord)
  ), seg as (
    select ord, x, y, lag(x) over (order by ord) px, lag(y) over (order by ord) py from pts
  ), d as (
    select *, coalesce(app.km_between(py, px, y, x), 0) km from seg
  ), c as (
    select *, sum(km) over (order by ord) cum, sum(km) over () total from d
  ), hit as (
    select c.*, least(greatest(p_fraction, 0), 1) * c.total target from c
    where c.cum >= least(greatest(p_fraction, 0), 1) * c.total - 1e-9
    order by ord limit 1
  )
  select
    case when km > 0 then py + (y - py) * ((target - (cum - km)) / km) else y end,
    case when km > 0 then px + (x - px) * ((target - (cum - km)) / km) else x end
  from hit
$$;

create or replace function app.drive_on_schedule() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer := 0;
  r record;
  v_leg jsonb;
  v_lat double precision;
  v_lng double precision;
begin
  for r in
    select v.id, i.legs
    from public.vehicles v
    join public.itineraries i on i.vehicle_id = v.id
    left join app.schedule_fixes f on f.vehicle_id = v.id
    where v.status in ('moving', 'on_ferry', 'offline')
      -- Someone else sent this car's position within the minute: theirs.
      and not (v.last_seen_at > now() - interval '60 seconds'
               and v.last_seen_at > coalesce(f.sent_at, '-infinity'::timestamptz) + interval '1 second')
  loop
    -- The last road or sea leg that has started; before the first, the first.
    select l into v_leg
    from jsonb_array_elements(r.legs) with ordinality t (l, ord)
    where l ->> 'kind' in ('drive', 'ferry')
      and jsonb_typeof(l -> 'path') = 'array' and jsonb_array_length(l -> 'path') > 1
    order by ((l ->> 'depart_at')::timestamptz <= now()) desc,
      case when (l ->> 'depart_at')::timestamptz <= now() then -ord else ord end
    limit 1;
    continue when v_leg is null;

    select p.lat, p.lng into v_lat, v_lng from app.point_along(v_leg -> 'path', app.leg_fraction(v_leg, now())) p;
    continue when v_lat is null;

    update public.vehicles set
      lat = v_lat, lng = v_lng, last_seen_at = now(),
      status = case when status = 'offline' then 'moving'::public.vehicle_status else status end
    where id = r.id;
    update public.profiles set lat = v_lat, lng = v_lng, position_at = now()
    where vehicle_id = r.id and role = 'driver';
    insert into app.schedule_fixes (vehicle_id, sent_at) values (r.id, now())
    on conflict (vehicle_id) do update set sent_at = excluded.sent_at;
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

revoke all on function app.drive_on_schedule() from public, anon, authenticated;
revoke all on function app.leg_fraction(jsonb, timestamptz) from public, anon, authenticated;
revoke all on function app.point_along(jsonb, double precision) from public, anon, authenticated;
revoke all on function app.km_between(double precision, double precision, double precision, double precision) from public, anon, authenticated;

select cron.schedule('drive-on-schedule', '20 seconds', 'select app.drive_on_schedule()');

-- Staff already read audit_log (RLS); drivers see none of it.
alter publication supabase_realtime add table public.audit_log;

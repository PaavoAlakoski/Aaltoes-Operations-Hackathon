-- The first driver on a car also reads what was sent to it before their
-- assignment: the seed messages, which a demo reset keeps while it recreates
-- the assignments. Only a replacement driver's turn starts at their
-- assignment, so they do not see what was meant for the driver before them.
create or replace function app.mine_on_car(p_vehicle text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assignments a
    where a.driver_id = auth.uid() and a.vehicle_id = p_vehicle
      and (a.created_at <= p_at or not exists (
        select 1 from public.assignments c
        where c.vehicle_id = a.vehicle_id and c.driver_id <> a.driver_id and c.created_at < a.created_at
      ))
      and not exists (
        select 1 from public.assignments b
        where b.vehicle_id = a.vehicle_id and b.driver_id <> a.driver_id
          and b.created_at > a.created_at and b.created_at <= p_at
      )
  )
  -- A car with no assignment at all: its messages are for whoever is on it.
  or (p_vehicle = (select app.my_vehicle())
      and not exists (select 1 from public.assignments a where a.vehicle_id = p_vehicle))
$$;

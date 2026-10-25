-- A message to a car is for the driver who had the car when it was sent.
-- Before, a driver read every message ever sent to the car they are on now,
-- so after a replacement driver took over, the new driver saw what was meant
-- for the old one, and the old one lost it as soon as the car was gone.
-- A driver's turn on a car runs from their assignment until another
-- driver's assignment on that car begins.

create or replace function app.mine_on_car(p_vehicle text, p_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assignments a
    where a.driver_id = auth.uid() and a.vehicle_id = p_vehicle and a.created_at <= p_at
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
revoke all on function app.mine_on_car(text, timestamptz) from public, anon;
grant execute on function app.mine_on_car(text, timestamptz) to authenticated, service_role;

drop policy "drivers read messages to them, their car or their corridor" on public.messages;
create policy "drivers read messages to them, their car or their corridor" on public.messages
  for select to authenticated using (
    to_user = (select auth.uid())
    or from_user = (select auth.uid())
    or (to_vehicle is not null and app.mine_on_car(to_vehicle, created_at))
    or to_corridor = (select app.my_corridor())
  );

create or replace function public.mark_message_read(p_message_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.messages set read_at = coalesce(read_at, now())
  where id = p_message_id
    and (to_user = auth.uid() or (to_vehicle is not null and app.mine_on_car(to_vehicle, created_at)));
  if not found then
    raise exception 'No such message for you.' using errcode = 'P0002';
  end if;
end
$$;

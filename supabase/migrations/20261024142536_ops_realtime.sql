-- Live updates.
--
-- Postgres Changes: incidents, messages, agent_suggestions and vehicles
-- stream to subscribers, filtered by the same RLS as a select.
--
-- Private channels (authorised by policies on realtime.messages):
--   corridor:<id>   Broadcast of live GPS. A driver may send only on the topic
--                   of their own car's corridor and cannot listen at all;
--                   staff listen to every corridor.
--   control-room    Presence of staff: who is online and which incident each
--                   has open. Staff only.

alter publication supabase_realtime add table
  public.incidents, public.messages, public.agent_suggestions, public.vehicles;

create policy "staff listen to corridors and the control room" on realtime.messages
  for select to authenticated using (
    (select app.is_staff())
    and (
      ((select realtime.topic()) like 'corridor:%' and extension = 'broadcast')
      or ((select realtime.topic()) = 'control-room' and extension in ('presence', 'broadcast'))
    )
  );

create policy "staff share presence in the control room" on realtime.messages
  for insert to authenticated with check (
    (select app.is_staff())
    and (select realtime.topic()) = 'control-room'
    and extension = 'presence'
  );

create policy "drivers send positions on their own corridor" on realtime.messages
  for insert to authenticated with check (
    (select app.user_role()) = 'driver'
    and (select app.my_corridor()) is not null
    and (select realtime.topic()) = 'corridor:' || (select app.my_corridor())
    and extension = 'broadcast'
  );

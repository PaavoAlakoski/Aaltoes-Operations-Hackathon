-- What each role can and cannot see or write, straight against the tables.
-- Runs in one transaction and rolls back, so it is safe on a live database.
-- Every assertion is collected into tap_out and the run ends by selecting it
-- as one TAP block, because the SQL editor and the Supabase MCP only show the
-- last result. Run: paste into the SQL editor (or execute_sql) and read `tap`.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
create temp table tap_out (n serial, line text);
grant all on tap_out to public;
grant all on sequence tap_out_n_seq to public;
insert into tap_out(line) select plan(39);

-- Fixtures: two corridors, a car on each, a driver per car, a dispatcher,
-- a supervisor, and a signed-up user nobody has set up yet.
insert into corridors (id, name, color) values
  ('test-c1', 'Test corridor 1', '#000'), ('test-c2', 'Test corridor 2', '#000');
insert into vehicles (id, corridor_id, label) values
  ('test-v1', 'test-c1', 'Car one'), ('test-v2', 'test-c2', 'Car two');
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000d1', 'd1@test.invalid', '{"full_name":"Driver One"}'),
  ('00000000-0000-4000-8000-0000000000d2', 'd2@test.invalid', '{"full_name":"Driver Two"}'),
  ('00000000-0000-4000-8000-0000000000a1', 'a1@test.invalid', '{"full_name":"Dispatcher"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'b1@test.invalid', '{"full_name":"Supervisor"}'),
  ('00000000-0000-4000-8000-0000000000e1', 'e1@test.invalid', '{"full_name":"New Signup"}');
update profiles set vehicle_id = 'test-v1' where id = '00000000-0000-4000-8000-0000000000d1';
update profiles set vehicle_id = 'test-v2' where id = '00000000-0000-4000-8000-0000000000d2';
update profiles set role = 'dispatcher' where id = '00000000-0000-4000-8000-0000000000a1';
update profiles set role = 'supervisor' where id = '00000000-0000-4000-8000-0000000000b1';
insert into assignments (driver_id, vehicle_id, shift_start, shift_end) values
  ('00000000-0000-4000-8000-0000000000d1', 'test-v1', now(), now() + interval '8 hours'),
  ('00000000-0000-4000-8000-0000000000d2', 'test-v2', now(), now() + interval '8 hours');
insert into incidents (id, vehicle_id, source, kind) values
  ('00000000-0000-4000-8000-00000000f001', 'test-v1', 'system', 'tracking_gap'),
  ('00000000-0000-4000-8000-00000000f002', 'test-v2', 'system', 'tracking_gap');
insert into agent_suggestions (incident_id, suggestion_type, rationale) values
  ('00000000-0000-4000-8000-00000000f002', 'message_vehicle', 'test');
insert into audit_log (actor_type, action) values ('system', 'test');
insert into messages (to_user, to_vehicle, to_corridor, body) values
  ('00000000-0000-4000-8000-0000000000d1', null, null, 'to d1'),
  (null, 'test-v1', null, 'to v1'),
  (null, null, 'test-c1', 'to c1'),
  ('00000000-0000-4000-8000-0000000000d2', null, null, 'to d2'),
  (null, 'test-v2', null, 'to v2'),
  (null, null, 'test-c2', 'to c2');
insert into driver_chat_messages (driver_id, vehicle_id, role, body) values
  ('00000000-0000-4000-8000-0000000000d1', 'test-v1', 'driver', 'chat d1'),
  ('00000000-0000-4000-8000-0000000000d2', 'test-v2', 'driver', 'chat d2');

-- Signs in as a user, with the claims the access token hook would mint.
create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare v_claims jsonb;
begin
  reset role;
  v_claims := (public.custom_access_token_hook(jsonb_build_object(
    'user_id', p_user,
    'claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')
  ))) -> 'claims';
  perform set_config('request.jwt.claims', v_claims::text, true);
  set local role authenticated;
end
$$;

-- The hook ------------------------------------------------------------------
insert into tap_out(line) select is(
  public.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-0000000000d1","claims":{"role":"authenticated"}}') -> 'claims' ->> 'app_role',
  'driver', 'hook puts the role in the token');
insert into tap_out(line) select is(
  public.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-0000000000d1","claims":{"role":"authenticated"}}') -> 'claims' ->> 'vehicle_id',
  'test-v1', 'hook puts the car in the token');
insert into tap_out(line) select is(
  public.custom_access_token_hook('{"user_id":"00000000-0000-4000-8000-0000000000d1","claims":{"role":"authenticated"}}') -> 'claims' ->> 'role',
  'authenticated', 'hook leaves the Postgres role alone');

-- Driver ----------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-8000-0000000000d1');

insert into tap_out(line) select results_eq('select id from profiles', array['00000000-0000-4000-8000-0000000000d1'::uuid],
  'driver sees only their own profile');
insert into tap_out(line) select results_eq($$select id from vehicles where id like 'test-%'$$, array['test-v1'],
  'driver sees only their own car');
insert into tap_out(line) select is((select count(*)::int from assignments), 1, 'driver sees only their own assignment');
insert into tap_out(line) select results_eq($$select vehicle_id from incidents where vehicle_id like 'test-%'$$, array['test-v1'],
  'driver sees incidents on their car only');
insert into tap_out(line) select results_eq(
  $$select body from messages where body like 'to %' order by body$$,
  array['to c1', 'to d1', 'to v1'],
  'driver sees messages to them, their car and their corridor, and nothing else');
insert into tap_out(line) select is_empty('select 1 from agent_suggestions', 'driver sees no agent suggestions');
insert into tap_out(line) select is_empty('select 1 from audit_log', 'driver sees no audit log');
insert into tap_out(line) select results_eq($$select body from driver_chat_messages where body like 'chat %'$$, array['chat d1'],
  'driver sees only their own chat with the agent');
insert into tap_out(line) select throws_ok(
  $$insert into driver_chat_messages (driver_id, role, body) values (auth.uid(), 'agent', 'fake reply')$$,
  '42501', null, 'driver cannot write the chat directly; only the agent function does');

insert into tap_out(line) select lives_ok(
  $$insert into incidents (vehicle_id, kind, description) values ('test-v1', 'breakdown', 'smoke')$$,
  'driver reports an incident on their car');
insert into tap_out(line) select results_eq(
  $$select source::text, reported_by, status::text from incidents where description = 'smoke'$$,
  $$values ('driver', '00000000-0000-4000-8000-0000000000d1'::uuid, 'open')$$,
  'the report is stamped as theirs, from a driver, open');
insert into tap_out(line) select throws_ok(
  $$insert into incidents (vehicle_id, kind) values ('test-v2', 'breakdown')$$,
  '42501', null, 'driver cannot report an incident on another car');
insert into tap_out(line) select throws_ok(
  $$insert into incidents (vehicle_id, kind, status) values ('test-v1', 'breakdown', 'resolved')$$,
  '42501', null, 'driver cannot choose the status of a report');
insert into tap_out(line) select throws_ok(
  $$update vehicles set status = 'delivered' where id = 'test-v1'$$,
  '42501', null, 'driver cannot write their car directly');
insert into tap_out(line) select throws_ok(
  $$update incidents set status = 'resolved'$$,
  '42501', null, 'driver cannot change an incident');
insert into tap_out(line) select throws_ok(
  $$update profiles set role = 'supervisor' where id = auth.uid()$$,
  '42501', null, 'driver cannot promote themselves');
insert into tap_out(line) select throws_ok(
  $$delete from messages$$,
  '42501', null, 'driver cannot delete messages');
insert into tap_out(line) select lives_ok(
  $$insert into messages (to_user, body) values ('00000000-0000-4000-8000-0000000000a1', 'reply to control')$$,
  'driver can write to a dispatcher');
insert into tap_out(line) select throws_ok(
  $$insert into messages (to_user, body) values ('00000000-0000-4000-8000-0000000000d2', 'hi')$$,
  '42501', null, 'driver cannot write to another driver');
insert into tap_out(line) select throws_ok(
  $$insert into messages (to_corridor, body) values ('test-c1', 'hi all')$$,
  '42501', null, 'driver cannot broadcast to their corridor');
insert into tap_out(line) select throws_ok(
  $$insert into agent_suggestions (incident_id, suggestion_type, rationale) values ('00000000-0000-4000-8000-00000000f001', 'message_vehicle', 'x')$$,
  '42501', null, 'driver cannot write agent suggestions');

-- Without the hook's claims, RLS falls back to the profile and stays as tight.
reset role;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}', true);
set local role authenticated;
insert into tap_out(line) select results_eq($$select id from vehicles where id like 'test-%'$$, array['test-v1'],
  'without hook claims a driver still sees only their own car');

-- A signed-up user nobody has set up --------------------------------------------
select pg_temp.login('00000000-0000-4000-8000-0000000000e1');
insert into tap_out(line) select is_empty($$select 1 from vehicles$$, 'a new sign-up sees no cars');
insert into tap_out(line) select is_empty($$select 1 from messages$$, 'a new sign-up sees no messages');
insert into tap_out(line) select throws_ok(
  $$insert into messages (to_user, body) values ('00000000-0000-4000-8000-0000000000a1', 'hello')$$,
  '42501', null, 'a new sign-up cannot message control');

-- Dispatcher ------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-8000-0000000000a1');
insert into tap_out(line) select is((select count(*)::int from vehicles where id like 'test-%'), 2, 'dispatcher sees every car');
insert into tap_out(line) select is((select count(*)::int from incidents where vehicle_id like 'test-%'), 3, 'dispatcher sees every incident, including the one the driver just reported');
insert into tap_out(line) select isnt_empty('select 1 from agent_suggestions', 'dispatcher sees agent suggestions');
insert into tap_out(line) select is((select count(*)::int from driver_chat_messages where body like 'chat %'), 2, 'dispatcher sees every driver chat');
insert into tap_out(line) select lives_ok(
  $$insert into messages (to_corridor, body) values ('test-c2', 'Ferry delayed 2 h')$$,
  'dispatcher messages a corridor');
insert into tap_out(line) select throws_ok(
  $$update vehicles set status = 'stopped'$$,
  '42501', null, 'dispatcher cannot write cars directly');
insert into tap_out(line) select throws_ok(
  $$insert into agent_suggestions (incident_id, suggestion_type, rationale) values ('00000000-0000-4000-8000-00000000f001', 'message_vehicle', 'x')$$,
  '42501', null, 'dispatcher cannot forge agent suggestions');
insert into tap_out(line) select throws_ok(
  $$insert into audit_log (actor_type, action) values ('user', 'x')$$,
  '42501', null, 'dispatcher cannot write the audit log');

-- Anyone without a session ------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
insert into tap_out(line) select throws_ok('select 1 from vehicles', '42501', null, 'anon cannot read cars');
insert into tap_out(line) select throws_ok('select 1 from messages', '42501', null, 'anon cannot read messages');
insert into tap_out(line) select isnt_empty('select 1 from records limit 1', 'anon still reads the snapshot the deployed app needs');

reset role;
insert into tap_out(line) select * from finish();
select string_agg(line, E'\n' order by n) as tap from tap_out;
rollback;

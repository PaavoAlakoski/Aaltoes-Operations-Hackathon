-- Who may send and listen on the private Realtime channels. Realtime checks a
-- join by setting realtime.topic and trying a select (to listen) or an insert
-- (to send) on realtime.messages, then rolling back; this does the same.
-- Same form as 01_rls.test.sql: one transaction, rolled back, one TAP block.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
create temp table tap_out (n serial, line text);
grant all on tap_out to public;
grant all on sequence tap_out_n_seq to public;
insert into tap_out(line) select plan(10);

insert into corridors (id, name, color) values
  ('test-c1', 'Test corridor 1', '#000'), ('test-c2', 'Test corridor 2', '#000');
insert into vehicles (id, corridor_id, label) values
  ('test-v1', 'test-c1', 'Car one'), ('test-v2', 'test-c2', 'Car two');
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000d1', 'd1@test.invalid'),
  ('00000000-0000-4000-8000-0000000000a1', 'a1@test.invalid');
update profiles set vehicle_id = 'test-v1' where id = '00000000-0000-4000-8000-0000000000d1';
update profiles set role = 'dispatcher' where id = '00000000-0000-4000-8000-0000000000a1';
insert into realtime.messages (topic, extension, event, payload, private) values
  ('corridor:test-c1', 'broadcast', 'position', '{}', true),
  ('control-room', 'presence', 'presence', '{}', true);

create function pg_temp.login(p_user uuid, p_topic text) returns void language plpgsql as $$
declare v_claims jsonb;
begin
  reset role;
  v_claims := (public.custom_access_token_hook(jsonb_build_object(
    'user_id', p_user,
    'claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')
  ))) -> 'claims';
  perform set_config('request.jwt.claims', v_claims::text, true);
  perform set_config('realtime.topic', p_topic, true);
  set local role authenticated;
end
$$;

-- Driver
select pg_temp.login('00000000-0000-4000-8000-0000000000d1', 'corridor:test-c1');
insert into tap_out(line) select lives_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private) values ('corridor:test-c1', 'broadcast', 'position', '{}', true)$$,
  'driver sends positions on their own corridor');
insert into tap_out(line) select is_empty(
  $$select 1 from realtime.messages where topic = realtime.topic()$$,
  'driver cannot listen to their corridor, so they never see other drivers');
select pg_temp.login('00000000-0000-4000-8000-0000000000d1', 'corridor:test-c2');
insert into tap_out(line) select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private) values ('corridor:test-c2', 'broadcast', 'position', '{}', true)$$,
  '42501', null, 'driver cannot send on another corridor');
select pg_temp.login('00000000-0000-4000-8000-0000000000d1', 'control-room');
insert into tap_out(line) select is_empty(
  $$select 1 from realtime.messages where topic = realtime.topic()$$,
  'driver cannot see who is in the control room');
insert into tap_out(line) select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private) values ('control-room', 'presence', 'presence', '{}', true)$$,
  '42501', null, 'driver cannot join control-room presence');

-- Dispatcher
select pg_temp.login('00000000-0000-4000-8000-0000000000a1', 'corridor:test-c1');
insert into tap_out(line) select isnt_empty(
  $$select 1 from realtime.messages where topic = realtime.topic()$$,
  'dispatcher listens to a corridor');
insert into tap_out(line) select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private) values ('corridor:test-c1', 'broadcast', 'position', '{}', true)$$,
  '42501', null, 'dispatcher cannot fake a car position');
select pg_temp.login('00000000-0000-4000-8000-0000000000a1', 'control-room');
insert into tap_out(line) select isnt_empty(
  $$select 1 from realtime.messages where topic = realtime.topic()$$,
  'dispatcher sees control-room presence');
insert into tap_out(line) select lives_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private) values ('control-room', 'presence', 'presence', '{}', true)$$,
  'dispatcher shares their presence');

-- Anyone without a session
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('realtime.topic', 'corridor:test-c1', true);
set local role anon;
insert into tap_out(line) select is_empty(
  $$select 1 from realtime.messages where topic = realtime.topic()$$,
  'anon cannot listen to a corridor');

reset role;
insert into tap_out(line) select * from finish();
select string_agg(line, E'\n' order by n) as tap from tap_out;
rollback;

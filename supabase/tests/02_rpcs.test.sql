-- The privileged RPCs: who may call each one, what it refuses, and that a
-- demotion takes effect at once even while the old token still says otherwise.
-- Same form as 01_rls.test.sql: one transaction, rolled back, one TAP block.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
create temp table tap_out (n serial, line text);
grant all on tap_out to public;
grant all on sequence tap_out_n_seq to public;
insert into tap_out(line) select plan(33);

insert into corridors (id, name, color) values
  ('test-c1', 'Test corridor 1', '#000'), ('test-c2', 'Test corridor 2', '#000');
insert into vehicles (id, corridor_id, label, status) values
  ('test-v1', 'test-c1', 'Car one', 'moving'), ('test-v2', 'test-c2', 'Car two', 'moving');
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
insert into incidents (id, vehicle_id, source, kind) values
  ('00000000-0000-4000-8000-00000000f001', 'test-v1', 'system', 'tracking_gap'),
  ('00000000-0000-4000-8000-00000000f002', 'test-v2', 'system', 'tracking_gap');
insert into agent_suggestions (id, incident_id, suggestion_type, payload, rationale) values
  ('00000000-0000-4000-8000-0000000005a1', '00000000-0000-4000-8000-00000000f001', 'message_vehicle', '{"body":"Call control"}', 'test'),
  ('00000000-0000-4000-8000-0000000005a2', '00000000-0000-4000-8000-00000000f002', 'set_vehicle_status', '{"status":"needs_check"}', 'test'),
  ('00000000-0000-4000-8000-0000000005a3', '00000000-0000-4000-8000-00000000f001', 'message_corridor', '{"body":"Queue at the port"}', 'test');
insert into messages (id, to_user, to_vehicle, body) values
  ('00000000-0000-4000-8000-00000000e001', null, 'test-v1', 'to v1'),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-0000000000d2', null, 'to d2');

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

-- Driver ------------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-8000-0000000000d1');
insert into tap_out(line) select is((report_position(60.17, 24.94, 120) ->> 'saved')::boolean, true,
  'driver saves a position');
insert into tap_out(line) select is((report_position(60.18, 24.95) ->> 'saved')::boolean, false,
  'a second position within 12 s is not saved');
insert into tap_out(line) select results_eq($$select lat, delay_seconds from vehicles where id = 'test-v1'$$,
  $$values (60.17::double precision, 120)$$, 'the first position and delay are stored on their car');
insert into tap_out(line) select throws_ok($$select report_position(91, 0)$$, '22023', null,
  'a position off the globe is refused');
insert into tap_out(line) select lives_ok($$select mark_message_read('00000000-0000-4000-8000-00000000e001')$$,
  'driver marks a message to their car as read');
insert into tap_out(line) select throws_ok($$select mark_message_read('00000000-0000-4000-8000-00000000e002')$$,
  'P0002', null, 'driver cannot mark another driver''s message');
insert into tap_out(line) select throws_ok($$select acknowledge_incident('00000000-0000-4000-8000-00000000f001')$$,
  '42501', null, 'driver cannot acknowledge incidents');
insert into tap_out(line) select throws_ok($$select decide_suggestion('00000000-0000-4000-8000-0000000005a1', 'approve')$$,
  '42501', null, 'driver cannot decide suggestions');
insert into tap_out(line) select throws_ok($$select set_vehicle_status('test-v1', 'delivered')$$,
  '42501', null, 'driver cannot set a car''s status');
insert into tap_out(line) select throws_ok($$select set_user_role('00000000-0000-4000-8000-0000000000d1', 'supervisor')$$,
  '42501', null, 'driver cannot promote themselves');

select pg_temp.login('00000000-0000-4000-8000-0000000000e1');
insert into tap_out(line) select throws_ok($$select report_position(60, 24)$$, '42501', null,
  'a driver with no car cannot report positions');

-- Dispatcher --------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-8000-0000000000a1');
insert into tap_out(line) select throws_ok($$select report_position(60, 24)$$, '42501', null,
  'dispatcher cannot report positions');
insert into tap_out(line) select results_eq(
  $$select status::text, acknowledged_by, assigned_to from acknowledge_incident('00000000-0000-4000-8000-00000000f001')$$,
  $$values ('acknowledged', '00000000-0000-4000-8000-0000000000a1'::uuid, '00000000-0000-4000-8000-0000000000a1'::uuid)$$,
  'dispatcher acknowledges an incident and takes it');
insert into tap_out(line) select throws_ok($$select acknowledge_incident('00000000-0000-4000-8000-00000000f001')$$,
  'PT409', null, 'a second acknowledgement is a conflict');
insert into tap_out(line) select throws_ok($$select assign_incident('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-0000000000d1')$$,
  '22023', null, 'an incident cannot be assigned to a driver');
insert into tap_out(line) select is(
  (select assigned_to from assign_incident('00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-0000000000b1')),
  '00000000-0000-4000-8000-0000000000b1'::uuid, 'dispatcher hands an incident to the supervisor');
insert into tap_out(line) select throws_ok($$select decide_suggestion('00000000-0000-4000-8000-0000000005a1', 'reject')$$,
  '22023', null, 'a rejection needs a reason');
insert into tap_out(line) select is(
  (select status::text from decide_suggestion('00000000-0000-4000-8000-0000000005a1', 'approve')),
  'approved', 'dispatcher approves a message suggestion');
insert into tap_out(line) select throws_ok($$select decide_suggestion('00000000-0000-4000-8000-0000000005a1', 'approve')$$,
  'PT409', null, 'deciding twice is a conflict');
insert into tap_out(line) select throws_ok($$select decide_suggestion('00000000-0000-4000-8000-0000000005a2', 'approve')$$,
  '42501', null, 'dispatcher cannot approve a car status change');
insert into tap_out(line) select throws_ok($$select set_vehicle_status('test-v1', 'stopped')$$,
  '42501', null, 'dispatcher cannot set a car''s status');
insert into tap_out(line) select throws_ok($$select set_user_role('00000000-0000-4000-8000-0000000000e1', 'driver', 'test-v1')$$,
  '42501', null, 'dispatcher cannot manage users');
insert into tap_out(line) select isnt_empty(
  $$select 1 from audit_log where actor_id = '00000000-0000-4000-8000-0000000000a1' and action = 'incident.acknowledge'$$,
  'the acknowledgement is in the audit log under the dispatcher');
insert into tap_out(line) select is(
  (select status::text from resolve_incident('00000000-0000-4000-8000-00000000f001', 'Driver called in')),
  'resolved', 'dispatcher resolves an incident');
insert into tap_out(line) select is(
  (select status::text from agent_suggestions where id = '00000000-0000-4000-8000-0000000005a3'),
  'rejected', 'resolving closes the suggestions nobody decided on');
insert into tap_out(line) select is((select open_incidents from ops_kpis),
  (select count(*)::int from incidents where status <> 'resolved'), 'KPI view counts open incidents');

-- Supervisor --------------------------------------------------------------------
select pg_temp.login('00000000-0000-4000-8000-0000000000b1');
insert into tap_out(line) select is(
  (select status::text from decide_suggestion('00000000-0000-4000-8000-0000000005a2', 'approve')),
  'approved', 'supervisor approves a car status change');
insert into tap_out(line) select is(
  (select status::text from set_vehicle_status('test-v2', 'needs_check', 'Driver reports a warning light')),
  'needs_check', 'supervisor sets a car''s status');
insert into tap_out(line) select is(
  (select vehicle_id from set_user_role('00000000-0000-4000-8000-0000000000e1', 'driver', 'test-v1')),
  'test-v1', 'supervisor puts a new driver on a car');
insert into tap_out(line) select throws_ok($$select set_user_role('00000000-0000-4000-8000-0000000000b1', 'dispatcher')$$,
  '22023', null, 'a supervisor cannot demote themselves');
insert into tap_out(line) select lives_ok($$select set_user_role('00000000-0000-4000-8000-0000000000a1', 'driver')$$,
  'supervisor demotes the dispatcher');

-- The demoted dispatcher still holds a token that says dispatcher.
reset role;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","app_role":"dispatcher","vehicle_id":null}', true);
set local role authenticated;
insert into tap_out(line) select throws_ok($$select acknowledge_incident('00000000-0000-4000-8000-00000000f002')$$,
  '42501', null, 'a demoted dispatcher with an old token can no longer act');

-- Anyone without a session --------------------------------------------------------
reset role;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
insert into tap_out(line) select throws_ok($$select report_position(60, 24)$$, '42501', null,
  'anon cannot call the RPCs');

reset role;
insert into tap_out(line) select * from finish();
select string_agg(line, E'\n' order by n) as tap from tap_out;
rollback;

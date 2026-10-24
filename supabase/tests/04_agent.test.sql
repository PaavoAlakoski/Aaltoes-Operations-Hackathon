-- The agent's side of the database: only the service role may call the
-- agent_* functions or carry out a move, a move needs a person's approval
-- first, and the ferry scenario stages a check-in the car cannot make.
-- Needs the demo seed (veh-00584). Same form as 01_rls.test.sql: one
-- transaction, rolled back, one TAP block.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
create temp table tap_out (n serial, line text);
grant all on tap_out to public;
grant all on sequence tap_out_n_seq to public;
insert into tap_out(line) select plan(16);

create function pg_temp.login(p_user uuid) returns void language plpgsql as $$
declare v_claims jsonb;
begin
  reset role;
  v_claims := (public.custom_access_token_hook(jsonb_build_object(
    'user_id', p_user, 'claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')))) -> 'claims';
  perform set_config('request.jwt.claims', v_claims::text, true);
  set local role authenticated;
end
$$;

-- Acts as the edge functions do: the service role, with no user in the token.
create function pg_temp.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
end
$$;

-- Clients cannot reach the agent's functions -----------------------------------
select pg_temp.login('20000000-0000-4000-8000-000000000001'); -- Mira, dispatcher
insert into tap_out(line) select throws_ok($$select agent_incident_context(gen_random_uuid())$$, '42501', null,
  'a dispatcher cannot call the agent''s context function');
insert into tap_out(line) select throws_ok($$select apply_suggestion(gen_random_uuid())$$, '42501', null,
  'a dispatcher cannot carry out a move directly');
insert into tap_out(line) select throws_ok($$select verify_agent_secret('guess')$$, '42501', null,
  'a dispatcher cannot probe the webhook secret');

select pg_temp.login('10000000-0000-4000-8000-000000000008'); -- Leo, driver of veh-00584
insert into tap_out(line) select throws_ok($$select simulate_ferry_jam()$$, '42501', null,
  'a driver cannot stage the scenario');
insert into tap_out(line) select throws_ok($$select agent_find_next_ferry('travemunde', now())$$, '42501', null,
  'a driver cannot call the agent''s lookups');

-- Staging the scenario ---------------------------------------------------------
-- Called with Mira's claims, but the result table is the test's own.
select pg_temp.login('20000000-0000-4000-8000-000000000001');
reset role;
create temp table staged as select * from simulate_ferry_jam();
grant select on staged to public;
insert into tap_out(line) select is((select kind || '/' || source from staged), 'ferry/control',
  'the scenario raises a ferry incident from control');

select pg_temp.as_service();
insert into tap_out(line) select is((agent_check_pickup_feasibility('veh-00584') ->> 'feasible')::boolean, false,
  'the car cannot make check-in');
insert into tap_out(line) select ok((agent_check_pickup_feasibility('veh-00584') ->> 'minutes_late')::int between 15 and 60,
  'it misses check-in by tens of minutes, not hours');
insert into tap_out(line) select is(jsonb_array_length(agent_find_next_ferry('travemunde', now())), 2,
  'the full sailing is not offered; the next two are');
insert into tap_out(line) select is(agent_find_hotel_near_port('travemunde') -> 0 ->> 'hotel_id', 'hotel-priwall',
  'hotels come cheapest first');

-- Carrying out a move ----------------------------------------------------------
reset role;
insert into agent_suggestions (id, incident_id, group_id, step, suggestion_type, payload, rationale, cost_cents)
select '00000000-0000-4000-8000-0000000005b1', id, '00000000-0000-4000-8000-0000000006b1', 1, 'rebook_ferry',
  jsonb_build_object('departure_id', (agent_find_next_ferry('travemunde', now()) -> 0 ->> 'departure_id')), 'test', 7500
from staged;
insert into agent_suggestions (id, incident_id, suggestion_type, payload, rationale)
select '00000000-0000-4000-8000-0000000005b2', id, 'rebook_ferry', jsonb_build_object('departure_id', gen_random_uuid()), 'test'
from staged;

select pg_temp.as_service();
insert into tap_out(line) select throws_ok($$select apply_suggestion('00000000-0000-4000-8000-0000000005b1')$$, 'PT409', null,
  'a move nobody approved is not carried out');

select pg_temp.login('20000000-0000-4000-8000-000000000001');
select decide_suggestion('00000000-0000-4000-8000-0000000005b1', 'approve');
select decide_suggestion('00000000-0000-4000-8000-0000000005b2', 'approve');
select pg_temp.as_service();
insert into tap_out(line) select is((select status::text from apply_suggestion('00000000-0000-4000-8000-0000000005b1')), 'executed',
  'an approved rebooking is carried out');
insert into tap_out(line) select is((select status from ferry_bookings where vehicle_id = 'veh-00584'), 'rebooked',
  'the car is on the new sailing');
insert into tap_out(line) select isnt_empty(
  -- created_at = now(): written in this transaction, not left over from a demo run.
  $$select 1 from messages where to_vehicle = 'veh-00584' and from_user is null and created_at = now()
    and body like 'Control rebooked your ferry%'$$,
  'the driver is told, by the agent');
insert into tap_out(line) select is((select status::text from apply_suggestion('00000000-0000-4000-8000-0000000005b2')), 'failed',
  'a move that cannot be done is marked failed, not half-done');
insert into tap_out(line) select isnt_empty(
  $$select 1 from audit_log where action = 'suggestion.execute' and details ->> 'suggestion_id' = '00000000-0000-4000-8000-0000000005b1'$$,
  'the carried-out move is in the audit log with who approved it');

reset role;
insert into tap_out(line) select * from finish();
select string_agg(line, E'\n' order by n) as tap from tap_out;
rollback;

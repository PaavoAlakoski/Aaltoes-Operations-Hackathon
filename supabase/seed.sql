-- Demo data for the live operations backend: five corridors, fifteen cars
-- from the dataset (in transit or waiting for pickup), a driver on each, three
-- standby drivers near Munich and two in the north, two dispatchers and a supervisor. Generated
-- once from dataset/data; positions are city-level approximations. Safe to run again: it replaces the demo rows.
--
-- Every demo user gets the same password: the setting seed.password if it is
-- set in this session, else the local-only default in supabase/README.md. On
-- a shared project set your own first, and never commit it:
--   select set_config('seed.password', '<a long random password>', false);

delete from public.incidents where vehicle_id in (select id from public.vehicles where corridor_id in ('fi-ring', 'fi-north', 'fi-de-ferry', 'dk-de', 'de-south'));
delete from public.messages where to_corridor in ('fi-ring', 'fi-north', 'fi-de-ferry', 'dk-de', 'de-south')
  or to_vehicle in (select id from public.vehicles where corridor_id in ('fi-ring', 'fi-north', 'fi-de-ferry', 'dk-de', 'de-south'));
delete from auth.users where email like '%@demo.bahn.test';
delete from public.vehicles where corridor_id in ('fi-ring', 'fi-north', 'fi-de-ferry', 'dk-de', 'de-south');
delete from public.corridors where id in ('fi-ring', 'fi-north', 'fi-de-ferry', 'dk-de', 'de-south');

insert into public.corridors (id, name, color, path) values
  ('fi-ring', 'Helsinki – Tampere – Turku', '#2f6fde', '[[24.9384, 60.1699], [24.4643, 60.9959], [23.761, 61.4978], [22.2666, 60.4518], [23.125, 60.3833], [24.6559, 60.2055], [24.9384, 60.1699]]'),
  ('fi-north', 'Helsinki – Lahti – Oulu', '#16a37f', '[[24.9384, 60.1699], [25.6612, 60.9827], [25.7473, 62.2426], [25.4651, 65.0121]]'),
  ('fi-de-ferry', 'Helsinki – Travemünde ferry – Hamburg', '#c2410c', '[[24.9384, 60.1699], [23.2, 59.75], [20.5, 58.9], [17.5, 56.6], [13.8, 54.95], [10.8667, 53.96], [10.6866, 53.8655], [9.9937, 53.5511]]'),
  ('dk-de', 'Malmö – Copenhagen – Rødby ferry – Hamburg', '#9333ea', '[[13.0038, 55.605], [12.5683, 55.6761], [11.95, 55.25], [11.3519, 54.656], [11.225, 54.503], [10.6866, 53.8655], [9.9937, 53.5511]]'),
  ('de-south', 'Hamburg – Frankfurt – Munich', '#b45309', '[[9.9937, 53.5511], [9.732, 52.3759], [9.4797, 51.3127], [8.6821, 50.1109], [11.0767, 49.4521], [11.582, 48.1351]]');

insert into public.vehicles (id, corridor_id, order_id, order_ref, label, registration, status, lat, lng, delay_seconds, eta, last_seen_at) values
  ('veh-00452', 'fi-ring', 'ord-00452', 'CD-420452', 'Bentley Continental GT', 'DEMO-FI-9NTWNM', 'moving', 60.65260, 22.55349, 60, now() + interval '5 hours' + interval '60 seconds', now() - interval '20 seconds'),
  ('veh-01013', 'fi-ring', 'ord-01013', 'CD-421013', 'Ferrari 296 GTB', 'DEMO-FI-VAJWJA', 'moving', 60.31865, 23.68167, 0, now() + interval '2 hours' + interval '0 seconds', now() - interval '20 seconds'),
  ('veh-00384', 'fi-ring', 'ord-00384', 'CD-420384', 'Volkswagen Golf', 'DEMO-FI-ET8K64', 'waiting_pickup', 61.41458, 23.64210, 0, null, null),
  ('veh-00366', 'fi-north', 'ord-00366', 'CD-420366', 'BMW M4', null, 'moving', 64.24591, 25.54317, 420, now() + interval '2 hours' + interval '420 seconds', now() - interval '20 seconds'),
  ('veh-00806', 'fi-north', 'ord-00806', 'CD-420806', 'Ferrari 296 GTB', 'DEMO-FI-NJMSM4', 'moving', 61.69038, 25.70956, 0, now() + interval '7 hours' + interval '0 seconds', now() - interval '20 seconds'),
  ('veh-00145', 'fi-north', 'ord-00145', 'CD-420145', 'Porsche 911 Carrera', null, 'moving', 60.55358, 25.27959, 90, now() + interval '10 hours' + interval '90 seconds', now() - interval '20 seconds'),
  ('veh-00917', 'fi-north', 'ord-00917', 'CD-420917', 'Mercedes-Benz S-Class', 'DEMO-FI-F8YA8G', 'moving', 61.02447, 25.66405, 1500, now() + interval '8 hours' + interval '1500 seconds', now() - interval '20 seconds'),
  ('veh-00584', 'fi-de-ferry', 'ord-00584', 'CD-420584', 'Bentley Continental GT', null, 'moving', 54.07402, 11.20455, 180, now() + interval '1 hours' + interval '180 seconds', now() - interval '20 seconds'),
  ('veh-00322', 'fi-de-ferry', 'ord-00322', 'CD-420322', 'Bentley Continental GT', null, 'on_ferry', 57.18985, 18.26937, 2400, now() + interval '6 hours' + interval '2400 seconds', now() - interval '20 seconds'),
  ('veh-00338', 'fi-de-ferry', 'ord-00338', 'CD-420338', 'Ferrari 296 GTB', null, 'moving', 59.97607, 24.13595, 0, now() + interval '10 hours' + interval '0 seconds', now() - interval '20 seconds'),
  ('veh-00537', 'dk-de', 'ord-00537', 'CD-420537', 'Bentley Continental GT', null, 'moving', 54.60139, 11.30660, 30, now() + interval '5 hours' + interval '30 seconds', now() - interval '20 seconds'),
  ('veh-00324', 'dk-de', 'ord-00324', 'CD-420324', 'Mercedes-Benz EQE', 'DEMO-SE-76BS6A', 'moving', 55.66575, 12.55328, 240, now() + interval '9 hours' + interval '240 seconds', now() - interval '20 seconds'),
  ('veh-00735', 'de-south', 'ord-00735', 'CD-420735', 'Porsche Taycan', null, 'moving', 49.84735, 9.64004, 0, now() + interval '4 hours' + interval '0 seconds', now() - interval '20 seconds'),
  ('veh-00071', 'de-south', 'ord-00071', 'CD-420071', 'Audi Q8 e-tron', null, 'moving', 51.31925, 9.48125, 960, now() + interval '8 hours' + interval '960 seconds', now() - interval '20 seconds'),
  ('veh-01024', 'de-south', 'ord-01024', 'CD-421024', 'Porsche Macan', null, 'waiting_pickup', 48.20637, 11.55466, 0, null, null);

-- Users. The trigger on auth.users creates each profile; the updates below set it up.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.email,
  extensions.crypt(coalesce(nullif(current_setting('seed.password', true), ''), 'bahn-demo-local'), extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.full_name), now(), now(), '', '', '', ''
from (values
  ('10000000-0000-4000-8000-000000000001', 'zoe.bergalund@demo.bahn.test', 'Zoe Bergalund'),
  ('10000000-0000-4000-8000-000000000002', 'daniel.arelmont@demo.bahn.test', 'Daniel Arelmont'),
  ('10000000-0000-4000-8000-000000000003', 'hanna.wenverin@demo.bahn.test', 'Hanna Wenverin'),
  ('10000000-0000-4000-8000-000000000004', 'sofia.lundervik@demo.bahn.test', 'Sofia Lundervik'),
  ('10000000-0000-4000-8000-000000000005', 'rafael.rillavik@demo.bahn.test', 'Rafael Rillavik'),
  ('10000000-0000-4000-8000-000000000006', 'kasper.carvell@demo.bahn.test', 'Kasper Carvell'),
  ('10000000-0000-4000-8000-000000000007', 'rafael.venwick@demo.bahn.test', 'Rafael Venwick'),
  ('10000000-0000-4000-8000-000000000008', 'leo.quellford@demo.bahn.test', 'Leo Quellford'),
  ('10000000-0000-4000-8000-000000000009', 'kasper.kovelund@demo.bahn.test', 'Kasper Kovelund'),
  ('10000000-0000-4000-8000-000000000010', 'jenna.erdalen@demo.bahn.test', 'Jenna Erdalen'),
  ('10000000-0000-4000-8000-000000000011', 'william.mervalen@demo.bahn.test', 'William Mervalen'),
  ('10000000-0000-4000-8000-000000000012', 'nadia.halverick@demo.bahn.test', 'Nadia Halverick'),
  ('10000000-0000-4000-8000-000000000013', 'cole.mervalen@demo.bahn.test', 'Cole Mervalen'),
  ('10000000-0000-4000-8000-000000000014', 'selma.talverick@demo.bahn.test', 'Selma Talverick'),
  ('10000000-0000-4000-8000-000000000015', 'elias.halverick@demo.bahn.test', 'Elias Halverick'),
  ('10000000-0000-4000-8000-000000000016', 'jonas.ekvall@demo.bahn.test', 'Jonas Ekvall'),
  ('10000000-0000-4000-8000-000000000017', 'mila.sorvenik@demo.bahn.test', 'Mila Sorvenik'),
  ('10000000-0000-4000-8000-000000000018', 'ida.brennholt@demo.bahn.test', 'Ida Brennholt'),
  ('10000000-0000-4000-8000-000000000019', 'tilda.marrenvik@demo.bahn.test', 'Tilda Marrenvik'),
  ('10000000-0000-4000-8000-000000000020', 'aron.veskelund@demo.bahn.test', 'Aron Veskelund'),
  ('20000000-0000-4000-8000-000000000001', 'mira.kestelund@demo.bahn.test', 'Mira Kestelund'),
  ('20000000-0000-4000-8000-000000000002', 'oskar.brennvik@demo.bahn.test', 'Oskar Brennvik'),
  ('30000000-0000-4000-8000-000000000001', 'helena.starkwood@demo.bahn.test', 'Helena Starkwood')
) as u (id, email, full_name);

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), id, id::text, 'email', jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true), now(), now(), now()
from auth.users where email like '%@demo.bahn.test';

update public.profiles set role = 'driver', vehicle_id = 'veh-00452', driver_ref = 'drv-060' where id = '10000000-0000-4000-8000-000000000001';
update public.profiles set role = 'driver', vehicle_id = 'veh-01013', driver_ref = 'drv-238' where id = '10000000-0000-4000-8000-000000000002';
update public.profiles set role = 'driver', vehicle_id = 'veh-00384', driver_ref = 'drv-002' where id = '10000000-0000-4000-8000-000000000003';
update public.profiles set role = 'driver', vehicle_id = 'veh-00366', driver_ref = 'drv-034' where id = '10000000-0000-4000-8000-000000000004';
update public.profiles set role = 'driver', vehicle_id = 'veh-00806', driver_ref = 'drv-110' where id = '10000000-0000-4000-8000-000000000005';
update public.profiles set role = 'driver', vehicle_id = 'veh-00145', driver_ref = 'drv-130' where id = '10000000-0000-4000-8000-000000000006';
update public.profiles set role = 'driver', vehicle_id = 'veh-00917', driver_ref = 'drv-030' where id = '10000000-0000-4000-8000-000000000007';
update public.profiles set role = 'driver', vehicle_id = 'veh-00584', driver_ref = 'drv-042' where id = '10000000-0000-4000-8000-000000000008';
update public.profiles set role = 'driver', vehicle_id = 'veh-00322', driver_ref = 'drv-319' where id = '10000000-0000-4000-8000-000000000009';
update public.profiles set role = 'driver', vehicle_id = 'veh-00338', driver_ref = 'drv-295' where id = '10000000-0000-4000-8000-000000000010';
update public.profiles set role = 'driver', vehicle_id = 'veh-00537', driver_ref = 'drv-250' where id = '10000000-0000-4000-8000-000000000011';
update public.profiles set role = 'driver', vehicle_id = 'veh-00324', driver_ref = 'drv-216' where id = '10000000-0000-4000-8000-000000000012';
update public.profiles set role = 'driver', vehicle_id = 'veh-00735', driver_ref = 'drv-260' where id = '10000000-0000-4000-8000-000000000013';
update public.profiles set role = 'driver', vehicle_id = 'veh-00071', driver_ref = 'drv-275' where id = '10000000-0000-4000-8000-000000000014';
update public.profiles set role = 'driver', vehicle_id = 'veh-01024', driver_ref = 'drv-249' where id = '10000000-0000-4000-8000-000000000015';
-- Standby drivers with no car, near Munich: the train-delay scenario's replacements.
update public.profiles set role = 'driver', vehicle_id = null, driver_ref = 'drv-301', availability = 'available', lat = 48.4029, lng = 11.7488, position_at = now() where id = '10000000-0000-4000-8000-000000000016';
update public.profiles set role = 'driver', vehicle_id = null, driver_ref = 'drv-302', availability = 'available', lat = 48.3705, lng = 10.8978, position_at = now() where id = '10000000-0000-4000-8000-000000000017';
update public.profiles set role = 'driver', vehicle_id = null, driver_ref = 'drv-303', availability = 'available', lat = 48.7665, lng = 11.4258, position_at = now() where id = '10000000-0000-4000-8000-000000000018';
-- Standby drivers in the north (waiting in Lübeck and Hamburg, both living in Hamburg in the dataset):
-- substitutes for the ferry corridors' drivers.
update public.profiles set role = 'driver', vehicle_id = null, driver_ref = 'drv-348', availability = 'available', lat = 53.8655, lng = 10.6866, position_at = now() where id = '10000000-0000-4000-8000-000000000019';
update public.profiles set role = 'driver', vehicle_id = null, driver_ref = 'drv-356', availability = 'available', lat = 53.5511, lng = 9.9937, position_at = now() where id = '10000000-0000-4000-8000-000000000020';
update public.profiles set availability = 'on_job' where role = 'driver' and vehicle_id is not null;
update public.vehicles set pickup_site_id = 'site-muc-isartal' where id = 'veh-01024';
update public.profiles set role = 'dispatcher', vehicle_id = null, driver_ref = null where id = '20000000-0000-4000-8000-000000000001';
update public.profiles set role = 'dispatcher', vehicle_id = null, driver_ref = null where id = '20000000-0000-4000-8000-000000000002';
update public.profiles set role = 'supervisor', vehicle_id = null, driver_ref = null where id = '30000000-0000-4000-8000-000000000001';

insert into public.assignments (driver_id, vehicle_id, shift_start, shift_end, status) values
  ('10000000-0000-4000-8000-000000000001', 'veh-00452', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000002', 'veh-01013', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000003', 'veh-00384', now() - interval '2 hours', now() + interval '10 hours', 'planned'),
  ('10000000-0000-4000-8000-000000000004', 'veh-00366', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000005', 'veh-00806', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000006', 'veh-00145', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000007', 'veh-00917', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000008', 'veh-00584', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000009', 'veh-00322', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000010', 'veh-00338', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000011', 'veh-00537', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000012', 'veh-00324', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000013', 'veh-00735', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000014', 'veh-00071', now() - interval '2 hours', now() + interval '10 hours', 'active'),
  ('10000000-0000-4000-8000-000000000015', 'veh-01024', now() - interval '2 hours', now() + interval '10 hours', 'planned');

-- A little history so the control room is not empty before the simulator runs.
insert into public.messages (from_user, to_corridor, body, created_at) values
  ('20000000-0000-4000-8000-000000000001', 'fi-de-ferry', 'The ferry from Vuosaari is running about 40 minutes late this morning. Plan your arrival at the terminal for that.', now() - interval '35 minutes');
insert into public.messages (from_user, to_vehicle, body, created_at) values
  ('20000000-0000-4000-8000-000000000002', (select id from public.vehicles where order_id = 'ord-00917'), 'The delivery site in Turku closes at 17:00. Call the desk if you will be later.', now() - interval '20 minutes');

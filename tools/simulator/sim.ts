// Drives the demo fleet so the control room has something to watch without
// real drivers. It signs in as each seeded driver with the public key and goes
// through exactly what the driver app does: Broadcast on the car's corridor,
// report_position at most every 15 s, incidents inserted under RLS. It has no
// service role key and cannot do anything a driver could not.
//
//   npm run simulate                       from the repo root
//   SIM_SPEED=60 npm run simulate          faster cars (default 30x real time)
//   SIM_INCIDENT_EVERY_S=0 npm run simulate  no random incidents (no model calls)
//
// Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and DEMO_PASSWORD in the root .env.
import { PositionPublisher, createOpsClient, fractionNear, pathKm, pointAlong, type LngLat, type OpsClient, type Vehicle } from '@bahn/shared';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const password = process.env.DEMO_PASSWORD;
if (!url || !key || !password) {
  console.error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and DEMO_PASSWORD in the repo root .env (see supabase/README.md).');
  process.exit(1);
}

const TICK_MS = 3000;
const SPEED = Number(process.env.SIM_SPEED ?? 30); // times real time
const KMH = 85;
const INCIDENT_EVERY_S = Number(process.env.SIM_INCIDENT_EVERY_S ?? 240);

// The seeded drivers, by email. Each signs in on its own client.
const DRIVERS = [
  'zoe.bergalund', 'daniel.arelmont', 'sofia.lundervik', 'rafael.rillavik', 'kasper.carvell', 'rafael.venwick',
  'leo.quellford', 'kasper.kovelund', 'jenna.erdalen', 'william.mervalen', 'nadia.halverick', 'cole.mervalen',
  'selma.talverick', 'hanna.wenverin', 'elias.halverick',
].map((n) => `${n}@demo.bahn.test`);

const INCIDENTS = [
  { kind: 'delay', severity: 'medium', description: 'Stau on the motorway, moving slowly.', addDelay: 900 },
  { kind: 'delay', severity: 'low', description: 'Roadworks, short detour.', addDelay: 420 },
  { kind: 'breakdown', severity: 'high', description: 'Warning light came on, pulled over to check.', addDelay: 1800 },
  { kind: 'documents', severity: 'medium', description: 'Border check asking for the transfer papers.', addDelay: 600 },
] as const;

interface Car {
  email: string;
  db: OpsClient;
  vehicle: Vehicle;
  path: LngLat[];
  fraction: number;
  direction: 1 | -1;
  delay: number;
  publisher: PositionPublisher;
}

async function signIn(email: string): Promise<Car | null> {
  const db = createOpsClient(url!, key!, { persist: false });
  const { error } = await db.auth.signInWithPassword({ email, password: password! });
  if (error) {
    console.warn(`  ${email}: ${error.message}`);
    return null;
  }
  const me = await db.from('profiles').select('vehicle_id').single();
  if (!me.data?.vehicle_id) return null;
  const v = await db.from('vehicles').select('*').eq('id', me.data.vehicle_id).single();
  if (!v.data) return null;
  const c = await db.from('corridors').select('*').eq('id', v.data.corridor_id).single();
  if (!c.data) return null;
  await db.realtime.setAuth();
  const path = c.data.path as LngLat[];
  return {
    email, db, vehicle: v.data, path,
    fraction: v.data.lat != null && v.data.lng != null ? fractionNear(path, v.data.lat, v.data.lng) : Math.random(),
    direction: Math.random() < 0.5 ? 1 : -1,
    delay: v.data.delay_seconds,
    publisher: new PositionPublisher(db, c.data.id, v.data.id),
  };
}

function step(car: Car) {
  const km = (KMH * SPEED * TICK_MS) / 3_600_000;
  const total = pathKm(car.path) || 1;
  car.fraction += (car.direction * km) / total;
  if (car.fraction >= 1 || car.fraction <= 0) {
    car.direction = car.direction === 1 ? -1 : 1;
    car.fraction = Math.min(Math.max(car.fraction, 0), 1);
  }
  // Delay drifts: traffic costs a little, a clear road wins a little back.
  car.delay = Math.max(0, car.delay + Math.round((Math.random() - 0.55) * 40));
}

async function maybeIncident(cars: Car[]) {
  if (!INCIDENT_EVERY_S) return;
  if (Math.random() > TICK_MS / 1000 / INCIDENT_EVERY_S) return;
  const car = cars[Math.floor(Math.random() * cars.length)]!;
  const pick = INCIDENTS[Math.floor(Math.random() * INCIDENTS.length)]!;
  const { error } = await car.db.from('incidents').insert({
    vehicle_id: car.vehicle.id, kind: pick.kind, severity: pick.severity, description: `[Simulator] ${pick.description}`,
  });
  if (error) return console.warn(`  incident for ${car.vehicle.id}: ${error.message}`);
  car.delay += pick.addDelay;
  console.log(`${new Date().toLocaleTimeString()}  incident: ${pick.kind} on ${car.vehicle.label} (${car.vehicle.order_ref})`);
}

console.log(`Signing in ${DRIVERS.length} drivers…`);
const cars = (await Promise.all(DRIVERS.map(signIn))).filter((c): c is Car => c !== null);
const moving = cars.filter((c) => c.vehicle.status === 'moving' || c.vehicle.status === 'on_ferry');
console.log(`${moving.length} cars moving at ${SPEED}x, ${cars.length - moving.length} waiting for pickup.`);
console.log(INCIDENT_EVERY_S ? `A random incident about every ${INCIDENT_EVERY_S} s (each one wakes the agent).` : 'No random incidents.');

let ticks = 0;
let stopping = false;
const timer = setInterval(async () => {
  ticks++;
  const results = await Promise.all(
    moving.map(async (car) => {
      step(car);
      const p = pointAlong(car.path, car.fraction);
      return car.publisher.publish(p.lat, p.lng, car.delay);
    }),
  );
  const failed = results.filter((r) => r.error);
  if (failed.length) console.warn(`  ${failed.length} sends failed: ${failed[0]!.error}`);
  if (ticks % 10 === 0) console.log(`${new Date().toLocaleTimeString()}  ${moving.length} cars sent ${ticks} fixes each`);
  await maybeIncident(moving);
}, TICK_MS);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await Promise.all(cars.map((c) => c.publisher.close()));
  console.log('Stopped. Cars go quiet; after 2 minutes the stale-car check raises one tracking-gap incident each.');
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

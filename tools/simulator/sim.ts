// Drives the demo fleet so the control room has something to watch without
// real drivers. It signs in as each seeded driver with the public key and goes
// through exactly what the driver app does: Broadcast on the car's corridor,
// report_position at most every 15 s, incidents inserted under RLS. It has no
// service role key and cannot do anything a driver could not.
//
// Each car is where its itinerary says it is now (scheduledPosition): along
// the Google road of the drive in progress at road speed, stopped on its
// breaks, waiting at the port, crossing on the ferry. In real time, so a car
// moves about 70 m a fix. Cars waiting for pickup and delivered cars stay put.
// A random incident stops its car for a while; the car then runs that much
// behind its schedule.
//
//   npm run simulate                            from the repo root
//   SIM_SKIP=leo.quellford npm run simulate     leave a driver to the driver app (its Pause)
//   SIM_INCIDENT_EVERY_S=0 npm run simulate     no random incidents (no model calls)
//
// Needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and DEMO_PASSWORD in the root .env.
import {
  PositionPublisher, createOpsClient, scheduledPosition, type Itinerary, type OpsClient, type Vehicle,
} from '@bahn/shared';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY;
const password = process.env.DEMO_PASSWORD;
if (!url || !key || !password) {
  console.error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and DEMO_PASSWORD in the repo root .env (see supabase/README.md).');
  process.exit(1);
}

const TICK_MS = 3000;
/** The car's row (status set by control or the agent) is read again this often. */
const VEHICLE_EVERY_MS = 30_000;
/** The itinerary is asked for again this often; the function rebuilds it when it is out of date. */
const ITINERARY_EVERY_MS = 10 * 60_000;
const INCIDENT_EVERY_S = Number(process.env.SIM_INCIDENT_EVERY_S ?? 240);
const SKIP = new Set((process.env.SIM_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean));

// Every seeded driver who has a car, by email. Each signs in on its own client.
const DRIVERS = [
  'zoe.bergalund', 'daniel.arelmont', 'sofia.lundervik', 'rafael.rillavik', 'kasper.carvell', 'rafael.venwick',
  'kasper.kovelund', 'jenna.erdalen', 'william.mervalen', 'nadia.halverick', 'cole.mervalen',
  'selma.talverick', 'hanna.wenverin', 'elias.halverick', 'leo.quellford',
].filter((n) => !SKIP.has(n)).map((n) => `${n}@demo.bahn.test`);

// A stop of so many seconds; the car then runs that far behind.
const INCIDENTS = [
  { kind: 'delay', severity: 'medium', description: 'Stau on the motorway, standing still.', stop: 900 },
  { kind: 'delay', severity: 'low', description: 'Roadworks, short detour.', stop: 420 },
  { kind: 'breakdown', severity: 'high', description: 'Warning light came on, pulled over to check.', stop: 1800 },
  { kind: 'documents', severity: 'medium', description: 'Border check asking for the transfer papers.', stop: 600 },
] as const;

// Statuses the car drives in. Stopped or needing a check, it stands still;
// waiting for pickup or delivered, the simulator leaves it alone.
const DRIVING: Vehicle['status'][] = ['moving', 'on_ferry', 'offline'];
const HOLDING: Vehicle['status'][] = ['stopped', 'needs_check'];

interface Car {
  email: string;
  db: OpsClient;
  vehicle: Vehicle;
  itinerary: Itinerary | null;
  /** How far behind its schedule the car runs, in ms: incidents and stops it was held for. */
  lag: number;
  /** The delay the car had when its schedule was last built, in seconds. */
  baseDelay: number;
  stoppedUntil: number;
  publisher: PositionPublisher;
}

async function itineraryOf(db: OpsClient): Promise<Itinerary | null> {
  const { data, error } = await db.functions.invoke<{ itinerary: Itinerary | null }>('build-itinerary', { body: {} });
  if (error) console.warn(`  itinerary: ${error.message}`);
  return data?.itinerary ?? null;
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
  await db.realtime.setAuth();
  return {
    email, db, vehicle: v.data, itinerary: await itineraryOf(db), lag: 0, baseDelay: v.data.delay_seconds, stoppedUntil: 0,
    publisher: new PositionPublisher(db, v.data.corridor_id, v.data.id),
  };
}

/** Reads the car and its itinerary again; a rebuilt schedule already counts the delay so far. */
async function refresh(car: Car, withItinerary: boolean) {
  const v = await car.db.from('vehicles').select('*').eq('id', car.vehicle.id).single();
  if (v.data) car.vehicle = v.data;
  if (!withItinerary) return;
  const it = await itineraryOf(car.db);
  if (it && it.built_at !== car.itinerary?.built_at) {
    car.lag = 0;
    car.baseDelay = car.vehicle.delay_seconds;
  }
  if (it) car.itinerary = it;
}

async function tick(car: Car, now: number) {
  if (!car.itinerary || !DRIVING.concat(HOLDING).includes(car.vehicle.status)) return null;
  // Standing still puts the car behind its schedule by as long as it stands.
  if (now < car.stoppedUntil || HOLDING.includes(car.vehicle.status)) car.lag += TICK_MS;
  const fix = scheduledPosition(car.itinerary.legs, now - car.lag);
  if (!fix) return null;
  return car.publisher.publish(fix.lat, fix.lng, car.baseDelay + Math.round(car.lag / 1000));
}

async function maybeIncident(cars: Car[]) {
  if (!INCIDENT_EVERY_S || cars.length === 0) return;
  if (Math.random() > TICK_MS / 1000 / INCIDENT_EVERY_S) return;
  const car = cars[Math.floor(Math.random() * cars.length)]!;
  const pick = INCIDENTS[Math.floor(Math.random() * INCIDENTS.length)]!;
  const { error } = await car.db.from('incidents').insert({
    vehicle_id: car.vehicle.id, kind: pick.kind, severity: pick.severity, description: `[Simulator] ${pick.description}`,
  });
  if (error) return console.warn(`  incident for ${car.vehicle.id}: ${error.message}`);
  car.stoppedUntil = Date.now() + pick.stop * 1000;
  console.log(`${new Date().toLocaleTimeString()}  incident: ${pick.kind} on ${car.vehicle.label} (${car.vehicle.order_ref}), stopped ${pick.stop / 60} min`);
}

console.log(`Signing in ${DRIVERS.length} drivers${SKIP.size ? ` (skipping ${[...SKIP].join(', ')})` : ''}…`);
const cars = (await Promise.all(DRIVERS.map(signIn))).filter((c): c is Car => c !== null);
for (const car of cars) {
  const fix = car.itinerary && scheduledPosition(car.itinerary.legs, Date.now());
  const where = !car.itinerary ? 'no itinerary, stays put'
    : !DRIVING.concat(HOLDING).includes(car.vehicle.status) ? `${car.vehicle.status.replace('_', ' ')}, stays put`
    : fix ? `${fix.leg.title}, ${Math.round(fix.fraction * 100)}% (${Math.round(fix.kmLeft)} km left)${fix.moving ? '' : ', standing'}`
    : 'no road on the itinerary';
  console.log(`  ${car.vehicle.order_ref ?? car.vehicle.id}  ${car.vehicle.label}: ${where}`);
}
console.log(INCIDENT_EVERY_S ? `A random incident about every ${INCIDENT_EVERY_S} s (each one wakes the agent).` : 'No random incidents.');

let ticks = 0;
let stopping = false;
const timer = setInterval(async () => {
  ticks++;
  const now = Date.now();
  if (ticks % (VEHICLE_EVERY_MS / TICK_MS) === 0) {
    await Promise.all(cars.map((c) => refresh(c, ticks % (ITINERARY_EVERY_MS / TICK_MS) === 0)));
  }
  const results = (await Promise.all(cars.map((car) => tick(car, now)))).filter((r) => r !== null);
  const failed = results.filter((r) => r.error);
  if (failed.length) console.warn(`  ${failed.length} sends failed: ${failed[0]!.error}`);
  if (ticks % 20 === 0) console.log(`${new Date().toLocaleTimeString()}  ${results.length} cars on the move, ${ticks} fixes each`);
  await maybeIncident(cars.filter((c) => c.itinerary && DRIVING.includes(c.vehicle.status)));
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

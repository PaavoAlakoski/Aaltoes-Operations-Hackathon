// build-itinerary: a driver's whole job as legs for the driver app's Overview.
// Called by a signed-in driver with their own session.
//
// Times come from the dataset (public.records: assignment steps, the ferry
// reservation, delivery window, tracking and events), moved by one shift so
// the job is happening now: the last dataset entry lands just before now. The
// ferry leg follows the live booking instead when there is one, so the
// ferry-miss scenario shows up here. The driver's own travel (train and flight
// out, train home) is planned around those times with slack for delays.
//
// Road legs come from Google once (only for the demo cars) and are kept in
// route_cache. The result is stored in itineraries and rebuilt when the ferry
// booking changes, the car's state puts it on another leg, or it is more than
// two hours old.
//
// Leo's order has the full plan (build). Every other driver's order gets a
// plain one (buildPlain): pickup, the drive (with the ferry when the car is
// booked on one) and the handover, timed from the car's live state rather
// than shifted dataset times.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { kmBetween, routePath, type LatLng, type RoutePath } from "../_shared/google.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

const REBUILD_AFTER_MS = 2 * 3600_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

type LngLat = [number, number];
type Place = { name: string; lat: number; lng: number };
type Leg = {
  id: string;
  kind: "train" | "flight" | "pickup" | "drive" | "ferry" | "handover";
  title: string;
  from: Place;
  to: Place;
  depart_at: string;
  arrive_at: string;
  timezone: string;
  arrive_timezone: string;
  deadline_at: string | null;
  minutes: number | null;
  slack_minutes: number;
  instructions: string[];
  link: { label: string; url: string } | null;
  booking_ref: string | null;
  status: "done" | "now" | "next";
  progress: number;
  path: LngLat[] | null;
  km: number | null;
  source: "google" | "estimate" | "dataset" | "booking" | "plan";
  evidence: string[];
};

// The dataset's sites and terminals are fictional and known only to city
// level, so the places a demo order passes through are pinned here.
const PLACES: Record<string, Place> = {
  "site-045": { name: "Norvarken Cologne", lat: 50.9958, lng: 6.9411 },
  "site-006": { name: "Kavellora Helsinki", lat: 60.2297, lng: 24.8543 },
  "terminal-west-baltic": { name: "Travemünde Skandinavienkai", lat: 53.96, lng: 10.8667 },
  "terminal-south-finland": { name: "Helsinki Vuosaari", lat: 60.2093, lng: 25.1951 },
};
const STATIONS: Record<string, Place> = {
  Tampere: { name: "Tampere station", lat: 61.4986, lng: 23.773 },
  "Helsinki Airport": { name: "Helsinki Airport", lat: 60.3172, lng: 24.9633 },
  "Helsinki station": { name: "Helsinki station", lat: 60.1719, lng: 24.9414 },
  "Cologne/Bonn Airport": { name: "Cologne/Bonn Airport", lat: 50.8659, lng: 7.1427 },
};
// Travemünde to Vuosaari the way the ferries go: out of Lübeck Bay, through
// the Kadet Channel, north of Bornholm, east of Gotland, up the Gulf of Finland.
const SEA_ROUTE: LngLat[] = [
  [10.8667, 53.96], [10.95, 54.05], [11.3, 54.35], [12.2, 54.48], [13.6, 54.75], [14.6, 55.35],
  [16.9, 56.2], [19.3, 57.4], [21.2, 58.7], [22.9, 59.45], [24.4, 59.85], [25.1, 60.12], [25.1951, 60.2093],
];

// The dataset's addresses are known to city level; their city centres.
const CITIES: Record<string, LatLng> = {
  Aarhus: { lat: 56.1567, lng: 10.2108 }, Antwerp: { lat: 51.2194, lng: 4.4025 }, Berlin: { lat: 52.52, lng: 13.405 },
  Cologne: { lat: 50.9375, lng: 6.9603 }, Copenhagen: { lat: 55.6761, lng: 12.5683 }, "Düsseldorf": { lat: 51.2277, lng: 6.7735 },
  Espoo: { lat: 60.2055, lng: 24.6559 }, Frankfurt: { lat: 50.1109, lng: 8.6821 }, Gothenburg: { lat: 57.7089, lng: 11.9746 },
  Graz: { lat: 47.0707, lng: 15.4395 }, Hamburg: { lat: 53.5511, lng: 9.9937 }, Helsinki: { lat: 60.1699, lng: 24.9384 },
  Lahti: { lat: 60.9827, lng: 25.6612 }, Leipzig: { lat: 51.3397, lng: 12.3731 }, Lille: { lat: 50.6292, lng: 3.0573 },
  Lyon: { lat: 45.764, lng: 4.8357 }, "Malmö": { lat: 55.605, lng: 13.0038 }, Marseille: { lat: 43.2965, lng: 5.3698 },
  Munich: { lat: 48.1351, lng: 11.582 }, Odense: { lat: 55.4038, lng: 10.4024 }, Oulu: { lat: 65.0121, lng: 25.4651 },
  Paris: { lat: 48.8566, lng: 2.3522 }, Rotterdam: { lat: 51.9244, lng: 4.4777 }, "Seinäjoki": { lat: 62.7903, lng: 22.8403 },
  Stockholm: { lat: 59.3293, lng: 18.0686 }, Stuttgart: { lat: 48.7758, lng: 9.1829 }, Tampere: { lat: 61.4978, lng: 23.761 },
  Turku: { lat: 60.4518, lng: 22.2666 }, Vantaa: { lat: 60.2934, lng: 25.0378 }, Vienna: { lat: 48.2082, lng: 16.3738 },
};

// Minutes, from the operators' timetables.
const TRAIN_TAMPERE_AIRPORT = 110;
const FLIGHT_HEL_CGN = 155;
const TRAIN_HELSINKI_TAMPERE = 100;
// Slack kept before the next thing.
const SLACK_AIRPORT = 120;
const SLACK_BEFORE_PICKUP = 12 * 60;
const SLACK_CHECK_IN = 60;
const SLACK_DISEMBARK = 45;
const SLACK_AFTER_HANDOVER = 60;
const SLACK_BEFORE_HANDOVER = 30;
const PICKUP_MINUTES = 30;
/** Ferries cruise at about 38 km/h: Travemünde to Vuosaari is about 29 hours. */
const FERRY_KMH = 38;
// EU driving rules: a 45-minute break after 4.5 hours at the wheel.
const breaks = (driveMinutes: number) => Math.floor(driveMinutes / 270) * 45;

const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(ms));
/** The offset of a time zone from UTC at a moment, in ms. */
const tzOffset = (ms: number, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};
/** The local clock time "HH:MM" in tz on the local date of ms. */
const localAt = (ms: number, clock: string, tz: string) => {
  const [h, m] = clock.split(":").map(Number);
  const day = Date.parse(ymd(ms, tz) + "T00:00:00Z");
  const guess = day + (h * 60 + m) * MIN;
  return guess - tzOffset(guess - tzOffset(guess, tz), tz);
};
/** On the local date of ms, the local clock time that iso has in tz. */
const onDate = (ms: number, isoTime: string, tz: string) =>
  localAt(ms, new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz }).format(new Date(isoTime)), tz);
const ymd = (ms: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms));
const navigate = (p: Place) => ({ label: "Navigate", url: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}` });
const transit = (a: Place, b: Place) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(a.name)}&destination=${encodeURIComponent(b.name)}&travelmode=transit`;

const pathKm = (path: LngLat[]) => {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += kmBetween({ lat: path[i - 1][1], lng: path[i - 1][0] }, { lat: path[i][1], lng: path[i][0] });
  return total;
};
/** How far along a path the vertex nearest to p is (0..1), and how far p is from it in km. */
function nearest(path: LngLat[], p: LatLng): { fraction: number; offKm: number } {
  const total = pathKm(path) || 1;
  let run = 0, best = { fraction: 0, offKm: Infinity };
  for (let i = 0; i < path.length; i++) {
    if (i > 0) run += kmBetween({ lat: path[i - 1][1], lng: path[i - 1][0] }, { lat: path[i][1], lng: path[i][0] });
    const d = kmBetween({ lat: path[i][1], lng: path[i][0] }, p);
    if (d < best.offKm) best = { fraction: run / total, offKm: d };
  }
  return best;
}
function pointAt(path: LngLat[], fraction: number): LatLng {
  let left = Math.min(Math.max(fraction, 0), 1) * pathKm(path);
  for (let i = 1; i < path.length; i++) {
    const a = { lat: path[i - 1][1], lng: path[i - 1][0] }, b = { lat: path[i][1], lng: path[i][0] };
    const seg = kmBetween(a, b);
    if (left <= seg) {
      const t = seg ? left / seg : 0;
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    left -= seg;
  }
  return { lat: path[path.length - 1][1], lng: path[path.length - 1][0] };
}

/** The road from a to b: from route_cache, else from Google once. */
async function road(vehicleId: string, a: Place, b: Place): Promise<RoutePath> {
  const key = `${a.lat.toFixed(3)},${a.lng.toFixed(3)}>${b.lat.toFixed(3)},${b.lng.toFixed(3)}`;
  const { data: hit } = await db.from("route_cache").select("*").eq("key", key).maybeSingle();
  if (hit) return { path: hit.path as LngLat[], km: hit.km, minutes: hit.minutes, source: hit.source as RoutePath["source"] };
  const r = await routePath(vehicleId, a, b);
  // A fallback is not cached, so Google is asked again once it is allowed.
  if (r.source === "google") {
    await db.from("route_cache").upsert({ key, path: r.path, km: r.km, minutes: r.minutes, source: r.source });
  }
  return r;
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

async function records(orderId: string) {
  const { data, error } = await db.from("records").select("collection,data").eq("order_id", orderId);
  if (error) throw new Error(`records: ${error.message}`);
  const by = (c: string) => (data ?? []).filter((r) => r.collection === c).map((r) => r.data as Row);
  return {
    steps: by("assignment_steps"),
    reservations: by("travel_reservations"),
    windows: by("time_windows"),
    tracking: by("tracking_observations"),
    events: by("operational_events"),
    proofs: by("proofs"),
    documents: by("documents"),
  };
}

async function build(me: { id: string; driver_ref: string | null }, vehicle: Row): Promise<{ legs: Leg[]; shift: number; departureId: string | null }> {
  const r = await records(vehicle.order_id);
  const pickupStep = r.steps.find((s) => s.kind === "VEHICLE_PICKUP");
  const ferryStep = r.steps.find((s) => s.kind === "VEHICLE_FERRY");
  const deliveryStep = r.steps.find((s) => s.kind === "VEHICLE_DELIVERY");
  const reservation = r.reservations.find((x) => x.kind === "FERRY");
  if (!pickupStep || !ferryStep || !deliveryStep || !reservation) throw new NoPlan("this order has no drive-and-ferry plan in the dataset");
  const pickupSite = (await site(pickupStep.transport_point_id)) ?? "";
  const deliverySite = (await site(deliveryStep.transport_point_id)) ?? "";
  const pickup = PLACES[pickupSite], delivery = PLACES[deliverySite];
  const portOut = PLACES[reservation.origin_terminal_id], portIn = PLACES[reservation.destination_terminal_id];
  if (!pickup || !delivery || !portOut || !portIn) throw new NoPlan("no full plan for this order's places");

  // One shift for every dataset time: the last entry lands just before now.
  const stamps = [...r.tracking.map((t) => t.observed_at), ...r.events.map((e) => e.recorded_at)].map(Date.parse);
  const last = Math.max(...stamps);
  const shift = Date.now() - 5 * MIN - last;
  const S = (t: string) => Date.parse(t) + shift;
  const BER = "Europe/Berlin", HEL = "Europe/Helsinki";

  const ev = (cmd: string) => r.events.find((e) => e.command === cmd);
  const started = ev("assignment.started"), pickedUp = ev("vehicle.picked_up"), proof = ev("proof.submitted");
  const cmr = r.documents.find((d) => d.kind === "CMR" && d.status === "SIGNED");
  const lastFix = r.tracking.sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)).at(-1);
  // The whole trip's length, from the last fix: remaining km over the share left.
  const tripKm = lastFix && Number(lastFix.progress_fraction) < 1
    ? Number(lastFix.distance_remaining_km) / (1 - Number(lastFix.progress_fraction))
    : null;

  const pickupAt = S(pickedUp?.recorded_at ?? pickupStep.completed_at ?? pickupStep.scheduled_start_at);

  // The live booking wins over the dataset's ferry times, unless it is left
  // over from an earlier scenario run and sailed before this pickup.
  const { data: booking } = await db.from("ferry_bookings")
    .select("status, departure:ferry_departures(id,operator,departs_at,check_in_closes_at)")
    .eq("vehicle_id", vehicle.id).in("status", ["booked", "rebooked", "boarded"]).maybeSingle();
  const booked = booking?.departure as Row | undefined;
  const dep = booked && Date.parse(booked.departs_at) > pickupAt ? booked : undefined;
  const crossing = Date.parse(reservation.expected_arrival_at) - Date.parse(reservation.departure_at);
  const ferryDepart = dep ? Date.parse(dep.departs_at) : S(reservation.departure_at);
  const checkInCloses = dep ? Date.parse(dep.check_in_closes_at) : S(reservation.check_in_cutoff_at);
  const ferryArrive = ferryDepart + crossing;

  const pickupDone = S(proof?.recorded_at ?? pickupStep.completed_at);
  const promise = r.windows.find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.is_selected) ?? deliveryStep;
  // An appointment keeps its local clock times (inside opening hours); only
  // its date moves with the shift.
  const handoverStart = onDate(S(promise.start_at ?? promise.scheduled_start_at), promise.start_at ?? promise.scheduled_start_at, HEL);
  const handoverEnd = onDate(handoverStart, promise.end_at ?? promise.scheduled_end_at, HEL);

  const [toPort, toDealer] = await Promise.all([road(vehicle.id, pickup, portOut), road(vehicle.id, portIn, delivery)]);

  // Where the car is on the road to the port: its live position if it is on
  // the road, else the dataset's last fix (and the car is moved there).
  let progress = 0;
  const onRoad = vehicle.lat != null ? nearest(toPort.path, { lat: vehicle.lat, lng: vehicle.lng }) : null;
  if (onRoad && onRoad.offKm < 15) progress = onRoad.fraction;
  else if (lastFix && tripKm) {
    const kmDone = Number(lastFix.progress_fraction) * tripKm;
    progress = Math.min(kmDone / (pathKm(toPort.path) || toPort.km), 0.95);
    if (["moving", "stopped"].includes(vehicle.status)) {
      const p = pointAt(toPort.path, progress);
      await db.from("vehicles").update({ lat: p.lat, lng: p.lng, last_seen_at: new Date().toISOString() }).eq("id", vehicle.id);
      await db.from("profiles").update({ lat: p.lat, lng: p.lng, position_at: new Date().toISOString() }).eq("id", me.id);
    }
  }

  // Which leg is happening, from the car's live state.
  const atSea = vehicle.status === "on_ferry" || booking?.status === "boarded";
  const delivered = vehicle.status === "delivered";
  const current = delivered ? 7 : atSea ? 4 : 3;
  const status = (i: number): Leg["status"] => (i < current ? "done" : i === current ? "now" : "next");

  // Drive to the port: Google's time plus breaks; when under way, what is left
  // plus the car's current delay.
  const driveTotal = toPort.minutes + breaks(toPort.minutes);
  const leftMin = (1 - progress) * toPort.minutes;
  const portEta = current === 3
    ? Date.now() + (leftMin + breaks(leftMin)) * MIN + (vehicle.delay_seconds ?? 0) * 1000
    : pickupDone + driveTotal * MIN;
  const portSlack = Math.round((checkInCloses - portEta) / MIN);
  const leaveBy = checkInCloses - (SLACK_CHECK_IN + driveTotal) * MIN;

  // The evening flight the day before pickup (Helsinki 17:25), or earlier if
  // that leaves less than the slack before the pickup.
  let flightDepart = localAt(pickupAt - DAY, "17:25", HEL);
  while (pickupAt - (flightDepart + FLIGHT_HEL_CGN * MIN) < SLACK_BEFORE_PICKUP * MIN) flightDepart -= DAY;
  const flightLand = flightDepart + FLIGHT_HEL_CGN * MIN;
  const trainArrive = flightDepart - SLACK_AIRPORT * MIN;
  const trainDepart = trainArrive - TRAIN_TAMPERE_AIRPORT * MIN;
  // Straight to the dealer after the ferry, or on the handover morning when
  // the handover is more than half a day later (the car waits at the terminal).
  const waitsAtPort = handoverStart - (ferryArrive + (SLACK_DISEMBARK + toDealer.minutes) * MIN) > 12 * 60 * MIN;
  const dealerDepart = waitsAtPort
    ? handoverStart - (toDealer.minutes + SLACK_BEFORE_HANDOVER) * MIN
    : ferryArrive + SLACK_DISEMBARK * MIN;
  const dealerArrive = dealerDepart + toDealer.minutes * MIN;
  const homeDepart = handoverStart + SLACK_AFTER_HANDOVER * MIN + 60 * MIN;
  const home = STATIONS.Tampere, hel = STATIONS["Helsinki station"], airport = STATIONS["Helsinki Airport"];
  const cgn = STATIONS["Cologne/Bonn Airport"];
  const label = vehicle.label as string;
  const ref = reservation.booking_reference as string;

  const legs: Leg[] = [
    {
      id: "train-out", kind: "train", title: "Train to Helsinki Airport", from: home, to: airport,
      depart_at: iso(trainDepart), arrive_at: iso(trainArrive), timezone: HEL,
      arrive_timezone: HEL, deadline_at: null, minutes: TRAIN_TAMPERE_AIRPORT, slack_minutes: SLACK_AIRPORT,
      instructions: [
        `VR InterCity from Tampere at ${hhmm(trainDepart, HEL)}; change at Tikkurila for the I/P train to the airport.`,
        "Buy the ticket in the VR app or at vr.fi; keep the receipt for your expense claim.",
      ],
      link: { label: "Buy ticket", url: "https://www.vr.fi/en" }, booking_ref: null,
      status: status(0), progress: status(0) === "done" ? 1 : 0, path: null, km: 187, source: "plan",
      evidence: started ? [started.id] : [],
    },
    {
      id: "flight-out", kind: "flight", title: "Flight to Cologne", from: airport, to: cgn,
      depart_at: iso(flightDepart), arrive_at: iso(flightLand), timezone: HEL,
      arrive_timezone: BER, deadline_at: null, minutes: FLIGHT_HEL_CGN,
      slack_minutes: Math.round((pickupAt - flightLand) / MIN),
      instructions: [
        `Helsinki ${hhmm(flightDepart, HEL)} → Cologne/Bonn ${hhmm(flightLand, BER)} local, the evening before pickup.`,
        "Hand luggage only; the car has no room for a suitcase with the delivery papers.",
        "From the airport take the S19 to Köln Hbf and sleep near the station.",
      ],
      link: { label: "Find flights", url: `https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from HEL to CGN on ${ymd(flightDepart, HEL)}`)}` },
      booking_ref: null, status: status(1), progress: status(1) === "done" ? 1 : 0, path: null, km: 1530, source: "plan",
      evidence: started ? [started.id] : [],
    },
    {
      id: "pickup", kind: "pickup", title: `Collect the ${label}`, from: pickup, to: pickup,
      depart_at: iso(pickupAt), arrive_at: iso(pickupDone), timezone: BER,
      arrive_timezone: BER, deadline_at: null, minutes: null, slack_minutes: 0,
      instructions: [
        `${pickup.name}, ${hhmm(pickupAt, BER)}. ${pickupStep.note?.split("Site procedure: ")[1] ?? ""}`.trim(),
        "Take the pickup photos and get the CMR signed before you drive off.",
      ],
      link: navigate(pickup), booking_ref: null, status: status(2), progress: status(2) === "done" ? 1 : 0,
      path: null, km: null, source: "dataset",
      evidence: [pickedUp?.id, proof?.id, cmr?.id].filter(Boolean) as string[],
    },
    {
      id: "drive-port", kind: "drive", title: `Drive to ${portOut.name.split(" ")[0]}`, from: pickup, to: portOut,
      depart_at: iso(pickupDone), arrive_at: iso(portEta), timezone: BER,
      arrive_timezone: BER, deadline_at: iso(checkInCloses), minutes: toPort.minutes, slack_minutes: portSlack,
      instructions: [
        current < 3
          ? `Leave by ${hhmm(leaveBy, BER)} to reach check-in with an hour to spare.`
          : portSlack >= 0
          ? `At this pace you reach the port ${hhmm(portEta, BER)}, ${portSlack} min before check-in closes.`
          : `At this pace you reach the port ${hhmm(portEta, BER)}, ${-portSlack} min after check-in closes. Tell the assistant in Chat.`,
        `About ${Math.round(toPort.km)} km by road. Take a 45-minute break after 4½ hours at the wheel.`,
        `Check-in at ${portOut.name} closes ${hhmm(checkInCloses, BER)}.`,
      ],
      link: navigate(portOut), booking_ref: null, status: status(3),
      progress: status(3) === "done" ? 1 : status(3) === "now" ? progress : 0,
      path: toPort.path, km: toPort.km, source: toPort.source, evidence: lastFix ? [lastFix.id] : [],
    },
    {
      id: "ferry", kind: "ferry", title: "Ferry to Helsinki", from: portOut, to: portIn,
      depart_at: iso(ferryDepart), arrive_at: iso(ferryArrive), timezone: BER,
      arrive_timezone: HEL, deadline_at: null, minutes: null,
      // Spare time between docking and the drive to the dealer.
      slack_minutes: Math.round((dealerDepart - ferryArrive) / MIN),
      instructions: [
        `Sails ${hhmm(ferryDepart, BER)}, arrives Vuosaari ${hhmm(ferryArrive, HEL)} Helsinki time.`,
        `Show booking ${ref} at the check-in gate; the driver cabin is included.`,
        "Keep the keys and the CMR with you on board.",
      ],
      link: { label: "Manage booking", url: "https://www.finnlines.com/en/" }, booking_ref: ref, status: status(4),
      progress: status(4) === "done" ? 1 : status(4) === "now" ? Math.min(Math.max((Date.now() - ferryDepart) / crossing, 0), 1) : 0,
      path: SEA_ROUTE, km: Math.round(pathKm(SEA_ROUTE)), source: dep ? "booking" : "dataset", evidence: [reservation.id],
    },
    {
      id: "drive-dealer", kind: "drive", title: `Drive to ${delivery.name}`, from: portIn, to: delivery,
      depart_at: iso(dealerDepart), arrive_at: iso(dealerArrive), timezone: HEL,
      arrive_timezone: HEL, deadline_at: iso(handoverStart), minutes: toDealer.minutes,
      slack_minutes: Math.round((handoverStart - dealerArrive) / MIN),
      instructions: [
        `About ${Math.round(toDealer.km)} km, ${toDealer.minutes} min through Helsinki.`,
        waitsAtPort
          ? `The handover is ${hhmm(handoverStart, HEL)}, so after the ferry leave the car in the Vuosaari terminal car park and drive over that morning.`
          : `The handover window opens ${hhmm(handoverStart, HEL)}.`,
      ],
      link: navigate(delivery), booking_ref: null, status: status(5), progress: status(5) === "done" ? 1 : 0,
      path: toDealer.path, km: toDealer.km, source: toDealer.source, evidence: [],
    },
    {
      id: "handover", kind: "handover", title: `Hand over at ${delivery.name}`, from: delivery, to: delivery,
      depart_at: iso(handoverStart), arrive_at: iso(handoverEnd), timezone: HEL,
      arrive_timezone: HEL, deadline_at: null, minutes: null, slack_minutes: 0,
      instructions: [
        `Between ${hhmm(handoverStart, HEL)} and ${hhmm(handoverEnd, HEL)}.`,
        `${deliveryStep.note?.split("Site procedure: ")[1] ?? "Hand over the keys and papers at the desk."}`,
        "Get the CMR signed at handover and photograph the car.",
      ],
      link: navigate(delivery), booking_ref: null, status: status(6), progress: status(6) === "done" ? 1 : 0,
      path: null, km: null, source: "dataset", evidence: [],
    },
    {
      id: "train-home", kind: "train", title: "Train home to Tampere", from: hel, to: home,
      depart_at: iso(homeDepart), arrive_at: iso(homeDepart + TRAIN_HELSINKI_TAMPERE * MIN), timezone: HEL,
      arrive_timezone: HEL, deadline_at: null, minutes: TRAIN_HELSINKI_TAMPERE,
      slack_minutes: SLACK_AFTER_HANDOVER,
      instructions: [
        `Any VR train from Helsinki after ${hhmm(homeDepart, HEL)}; they leave about every half hour.`,
        "Keep the receipt for your expense claim.",
      ],
      link: { label: "Buy ticket", url: "https://www.vr.fi/en" }, booking_ref: null, status: status(7),
      progress: status(7) === "done" ? 1 : 0, path: null, km: 187, source: "plan", evidence: [],
    },
  ];
  // The transit link helps with the trains when the ticket site is not enough.
  legs[0].instructions.push(`Route: ${transit(home, airport)}`);
  // The booked departure, used or not, so a new booking triggers a rebuild.
  return { legs, shift: Math.round(shift / 1000), departureId: booked?.id ?? null };
}

/** Thrown when an order has no full drive-and-ferry plan, so the plain one is built instead. */
class NoPlan extends Error {}

/** A straight line in steps of about 10 km, so progress along it can be measured. */
function densify(path: LngLat[]): LngLat[] {
  if (path.length !== 2) return path;
  const [a, b] = path;
  const n = Math.max(1, Math.ceil(kmBetween({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }) / 10));
  return Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as LngLat);
}

/** A dataset address as a place, with its city, time zone and access note. */
async function address(id: string | null) {
  if (!id) return null;
  const { data } = await db.from("records").select("data").eq("collection", "addresses").eq("id", id).maybeSingle();
  const a = data?.data as Row | undefined;
  const at = a ? CITIES[a.city] : undefined;
  if (!a || !at) return null;
  return { place: { name: a.name as string, ...at }, city: a.city as string, tz: (a.timezone as string) ?? "Europe/Berlin", access: a.access_note as string | null };
}

const minutesText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`);

/** Any order without the full plan: pickup, the drive (or drive, ferry, drive) and the handover. */
async function buildPlain(vehicle: Row): Promise<{ legs: Leg[]; shift: number; departureId: string | null }> {
  const r = await records(vehicle.order_id);
  const { data: orderRow } = await db.from("records").select("data").eq("collection", "orders").eq("id", vehicle.order_id).maybeSingle();
  const order = orderRow?.data as Row | undefined;
  if (!order) throw new Error("the order is not in the dataset");
  const [from, to] = await Promise.all([address(order.pickup_address_id), address(order.delivery_address_id)]);
  if (!from || !to) throw new Error("no coordinates for this order's places");
  const { data: site } = vehicle.pickup_site_id
    ? await db.from("pickup_sites").select("*").eq("id", vehicle.pickup_site_id).maybeSingle()
    : { data: null };
  const pickup: Place = site ? { name: site.name, lat: site.lat, lng: site.lng } : from.place;
  const fromTz: string = site?.timezone ?? from.tz, toTz = to.tz;
  const delivery = to.place;

  const pickupStep = r.steps.find((s) => s.kind === "VEHICLE_PICKUP");
  const deliveryStep = r.steps.find((s) => s.kind === "VEHICLE_DELIVERY");
  const promise = r.windows.find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.is_selected) ?? deliveryStep;
  const ev = (cmd: string) => r.events.find((e) => e.command === cmd);
  const pickedUp = ev("vehicle.picked_up"), proof = ev("proof.submitted");
  const procedure = (step: Row | undefined) => step?.note?.split("Site procedure: ")[1] as string | undefined;

  // The ferry, when the car is booked on one.
  const { data: booking } = await db.from("ferry_bookings")
    .select("status, departure:ferry_departures(id,operator,from_port,to_port,departs_at,check_in_closes_at)")
    .eq("vehicle_id", vehicle.id).in("status", ["booked", "rebooked", "boarded"]).maybeSingle();
  const dep = booking?.departure as Row | undefined;
  let ferry: { out: Place & { tz: string }; in: Place & { tz: string }; sea: LngLat[] } | null = null;
  if (dep) {
    const { data: ports } = await db.from("ports").select("*").in("id", [dep.from_port, dep.to_port]);
    const out = ports?.find((p) => p.id === dep.from_port), inn = ports?.find((p) => p.id === dep.to_port);
    if (out && inn) {
      const pair = `${dep.from_port}>${dep.to_port}`;
      const sea = pair === "travemunde>helsinki-vuosaari" ? SEA_ROUTE
        : pair === "helsinki-vuosaari>travemunde" ? [...SEA_ROUTE].reverse()
        : densify([[out.lng, out.lat], [inn.lng, inn.lat]]);
      ferry = { out: { name: out.name, lat: out.lat, lng: out.lng, tz: out.timezone }, in: { name: inn.name, lat: inn.lat, lng: inn.lng, tz: inn.timezone }, sea };
    }
  }

  const now = Date.now();
  const status = vehicle.status as string;
  const delay = (vehicle.delay_seconds ?? 0) * 1000;
  const eta = vehicle.eta ? Date.parse(vehicle.eta) : null;
  const driveMin = (x: RoutePath) => x.minutes + breaks(x.minutes);
  const roads = ferry
    ? await Promise.all([road(vehicle.id, pickup, ferry.out), road(vehicle.id, ferry.in, delivery)])
    : [await road(vehicle.id, pickup, delivery)];
  for (const x of roads) x.path = densify(x.path);

  // Which leg is happening: 0 is the pickup, then each drive and the
  // crossing; one past the handover means delivered.
  const atSea = status === "on_ferry" || booking?.status === "boarded";
  const ferryDepart = dep ? Date.parse(dep.departs_at) : 0;
  const crossing = ferry ? (pathKm(ferry.sea) / FERRY_KMH) * 60 * MIN : 0;
  const ferryArrive = ferryDepart + crossing;
  const handoverIndex = ferry ? 4 : 2;
  const current = status === "delivered" ? handoverIndex + 1
    : status === "waiting_pickup" ? 0
    : !ferry ? 1
    : atSea ? 2
    : now < ferryDepart ? 1 : 3;

  // Times, worked out from the leg in progress outwards.
  const first = roads[0];
  let pickupAt: number, pickupDone: number, firstArrive: number;
  if (current === 0) {
    const slot = pickupStep?.scheduled_start_at as string | undefined;
    const pickupEta = vehicle.pickup_eta ? Date.parse(vehicle.pickup_eta) : null;
    pickupAt = pickupEta && pickupEta > now ? pickupEta : slot ? nextAt(slot, fromTz, now + 30 * MIN) : now + 60 * MIN;
    pickupDone = pickupAt + PICKUP_MINUTES * MIN;
    firstArrive = pickupDone + driveMin(first) * MIN;
  } else if (current === 1) {
    // On the road: what is left from the car's position, else its ETA.
    const near = vehicle.lat != null ? nearest(first.path, { lat: vehicle.lat, lng: vehicle.lng }) : null;
    if (near && near.offKm < 15) {
      const left = (1 - near.fraction) * first.minutes;
      firstArrive = now + (left + breaks(left)) * MIN + delay;
    } else if (!ferry && eta && eta > now) firstArrive = eta;
    else firstArrive = now + (driveMin(first) / 2) * MIN + delay;
    pickupDone = Math.min(now - 10 * MIN, firstArrive - driveMin(first) * MIN - delay);
    pickupAt = pickupDone - PICKUP_MINUTES * MIN;
  } else {
    // Past the first drive: it reached check-in in time, or ended at the ETA.
    firstArrive = ferry ? Date.parse(dep!.check_in_closes_at) - SLACK_CHECK_IN * MIN : Math.min(eta ?? now, now) - 60 * MIN;
    pickupDone = firstArrive - driveMin(first) * MIN;
    pickupAt = pickupDone - PICKUP_MINUTES * MIN;
  }

  // The drive after the ferry.
  let lastDepart = pickupDone, lastArrive = firstArrive;
  if (ferry) {
    lastDepart = ferryArrive + SLACK_DISEMBARK * MIN;
    lastArrive = current === 3 && eta && eta > now ? eta : lastDepart + driveMin(roads[1]) * MIN;
    if (current === 3) lastDepart = Math.min(lastDepart, now);
  }

  // The handover: that day's window if the car is there in time, else the
  // next day's.
  const ready = lastArrive + SLACK_BEFORE_HANDOVER * MIN;
  let handoverStart = ready, handoverEnd = ready + 60 * MIN, handoverDeadline = handoverEnd;
  const startIso = (promise?.start_at ?? promise?.scheduled_start_at) as string | undefined;
  const endIso = (promise?.end_at ?? promise?.scheduled_end_at) as string | undefined;
  if (startIso) {
    const length = endIso ? Math.max(Date.parse(endIso) - Date.parse(startIso), 30 * MIN) : 2 * 60 * MIN;
    const opens = onDate(lastArrive, startIso, toTz);
    handoverDeadline = opens + length;
    if (ready <= handoverDeadline) {
      handoverStart = Math.max(opens, ready);
      handoverEnd = handoverDeadline;
    } else {
      handoverStart = onDate(opens + DAY, startIso, toTz);
      handoverEnd = handoverStart + length;
      // The drive is measured against the handover it now aims for.
      handoverDeadline = handoverStart;
    }
  }

  const legStatus = (i: number): Leg["status"] => (i < current ? "done" : i === current ? "now" : "next");
  const progressOf = (i: number, a: number, b: number) =>
    legStatus(i) === "done" ? 1 : legStatus(i) === "now" ? Math.min(Math.max((now - a) / Math.max(b - a, MIN), 0), 1) : 0;
  const label = vehicle.label as string;
  // Today's closing time, while the pickup is still ahead.
  const closes = current === 0 && site?.closes_at && Date.parse(site.closes_at) > now ? Date.parse(site.closes_at) : null;
  const access = site?.access_note ?? from.access;

  const drive = (
    i: number, id: string, x: RoutePath, a: Place, b: Place, depart: number, arrive: number, tzA: string, tzB: string,
    deadline: number, extra: string[],
  ): Leg => ({
    id, kind: "drive", title: `Drive to ${b.name}`, from: a, to: b,
    depart_at: iso(depart), arrive_at: iso(arrive), timezone: tzA, arrive_timezone: tzB,
    deadline_at: iso(deadline), minutes: x.minutes, slack_minutes: Math.round((deadline - arrive) / MIN),
    instructions: [
      `About ${Math.round(x.km)} km, ${minutesText(driveMin(x))} with breaks. Take a 45-minute break after 4½ hours at the wheel.`,
      ...extra,
    ],
    link: navigate(b), booking_ref: null, status: legStatus(i), progress: progressOf(i, depart, arrive),
    path: x.path, km: x.km, source: x.source, evidence: [],
  });

  const legs: Leg[] = [{
    id: "pickup", kind: "pickup", title: `Collect the ${label}`, from: pickup, to: pickup,
    depart_at: iso(pickupAt), arrive_at: iso(pickupDone), timezone: fromTz, arrive_timezone: fromTz,
    deadline_at: closes ? iso(closes) : null, minutes: null, slack_minutes: 0,
    instructions: [
      `${pickup.name}, ${site?.city ?? from.city}, ${hhmm(pickupAt, fromTz)}. ${procedure(pickupStep) ?? ""}`.trim(),
      ...(closes ? [`Keys ${site.key_handover === "key_box" ? "from the key box" : "in person"} until ${hhmm(closes, fromTz)} local time.`] : []),
      ...(access ? [access] : []),
      "Take the pickup photos and get the CMR signed before you drive off.",
    ],
    link: navigate(pickup), booking_ref: null, status: legStatus(0), progress: legStatus(0) === "done" ? 1 : 0,
    path: null, km: null, source: "dataset", evidence: [pickedUp?.id, proof?.id].filter(Boolean) as string[],
  }];

  if (ferry) {
    const checkIn = Date.parse(dep!.check_in_closes_at);
    legs.push(drive(1, "drive-port", roads[0], pickup, ferry.out, pickupDone, firstArrive, fromTz, ferry.out.tz, checkIn,
      [`Check-in at ${ferry.out.name} closes ${hhmm(checkIn, ferry.out.tz)}.`]));
    legs.push({
      id: "ferry", kind: "ferry", title: `Ferry to ${ferry.in.name}`, from: ferry.out, to: ferry.in,
      depart_at: iso(ferryDepart), arrive_at: iso(ferryArrive), timezone: ferry.out.tz, arrive_timezone: ferry.in.tz,
      deadline_at: null, minutes: Math.round(crossing / MIN), slack_minutes: SLACK_DISEMBARK,
      instructions: [
        `${dep!.operator}: sails ${hhmm(ferryDepart, ferry.out.tz)}, arrives about ${hhmm(ferryArrive, ferry.in.tz)} local time.`,
        "Keep the keys and the CMR with you on board.",
      ],
      link: null, booking_ref: null, status: legStatus(2), progress: progressOf(2, ferryDepart, ferryArrive),
      path: ferry.sea, km: Math.round(pathKm(ferry.sea)), source: "booking", evidence: [],
    });
    legs.push(drive(3, "drive-dealer", roads[1], ferry.in, delivery, lastDepart, lastArrive, ferry.in.tz, toTz, handoverDeadline, []));
  } else {
    legs.push(drive(1, "drive", roads[0], pickup, delivery, pickupDone, firstArrive, fromTz, toTz, handoverDeadline, []));
  }
  if (handoverStart - lastArrive > 6 * 60 * MIN) {
    legs.at(-1)!.instructions.push(
      `You arrive ${hhmm(lastArrive, toTz)}, after the handover window. Keep the car somewhere safe overnight; the handover is ${hhmm(handoverStart, toTz)}.`,
    );
  }

  legs.push({
    id: "handover", kind: "handover", title: `Hand over at ${delivery.name}`, from: delivery, to: delivery,
    depart_at: iso(handoverStart), arrive_at: iso(handoverEnd), timezone: toTz, arrive_timezone: toTz,
    deadline_at: null, minutes: null, slack_minutes: 0,
    instructions: [
      `${delivery.name}, ${to.city}, between ${hhmm(handoverStart, toTz)} and ${hhmm(handoverEnd, toTz)}.`,
      procedure(deliveryStep) ?? "Hand over the keys and papers at the desk.",
      "Get the CMR signed at handover and photograph the car.",
    ],
    link: navigate(delivery), booking_ref: null, status: legStatus(handoverIndex),
    progress: legStatus(handoverIndex) === "done" ? 1 : 0, path: null, km: null, source: "dataset", evidence: [],
  });
  return { legs, shift: 0, departureId: dep?.id ?? null };
}

/** The first time at or after `after` when the clock in tz shows the time isoTime has there. */
function nextAt(isoTime: string, tz: string, after: number) {
  let t = onDate(after, isoTime, tz);
  while (t < after) t = onDate(t + DAY, isoTime, tz);
  return t;
}

/** The kind of leg the car's state says is happening, to tell when a saved itinerary is out of date. */
function legNow(status: string, boarded: boolean): Leg["kind"] | null {
  if (status === "delivered") return null;
  if (status === "waiting_pickup") return "pickup";
  return status === "on_ferry" || boarded ? "ferry" : "drive";
}

/** The dataset site of a transport point. */
async function site(pointId: string | null): Promise<string | null> {
  if (!pointId) return null;
  const { data } = await db.from("records").select("data").eq("collection", "transport_points").eq("id", pointId).maybeSingle();
  return (data?.data as Row | undefined)?.site_id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const asDriver = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: who } = await asDriver.auth.getUser();
  if (!who.user) return json({ error: "Sign in first." }, 401);
  const { data: me } = await db.from("profiles").select("id,role,vehicle_id,driver_ref").eq("id", who.user.id).single();
  if (!me || me.role !== "driver") return json({ error: "The itinerary is for drivers." }, 403);
  if (!me.vehicle_id) return json({ itinerary: null });

  const { data: vehicle } = await db.from("vehicles").select("*").eq("id", me.vehicle_id).single();
  if (!vehicle?.order_id) return json({ itinerary: null });

  const body = await req.json().catch(() => ({}));
  const { data: saved } = await db.from("itineraries").select("*").eq("vehicle_id", vehicle.id).maybeSingle();
  const { data: booking } = await db.from("ferry_bookings").select("departure_id,status").eq("vehicle_id", vehicle.id)
    .in("status", ["booked", "rebooked", "boarded"]).maybeSingle();
  const savedNow = (saved?.legs as Leg[] | undefined)?.find((l) => l.status === "now")?.kind ?? null;
  const fresh = saved && !body.rebuild && saved.driver_id === me.id &&
    saved.ferry_departure_id === (booking?.departure_id ?? null) &&
    savedNow === legNow(vehicle.status, booking?.status === "boarded") &&
    Date.now() - Date.parse(saved.built_at) < REBUILD_AFTER_MS;
  if (fresh) return json({ itinerary: saved });

  try {
    const { legs, shift, departureId } = await build(me, vehicle).catch((e) => {
      if (e instanceof NoPlan) return buildPlain(vehicle);
      throw e;
    });
    const row = { vehicle_id: vehicle.id, driver_id: me.id, legs, shift_seconds: shift, ferry_departure_id: departureId, built_at: new Date().toISOString() };
    const { data, error } = await db.from("itineraries").upsert(row).select("*").single();
    if (error) throw new Error(`saving: ${error.message}`);
    return json({ itinerary: data });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // An order whose places are not known simply has no itinerary.
    console.warn("build-itinerary", vehicle.id, message);
    return json({ itinerary: null, note: message });
  }
});

// When can the car's driver be at the pickup, and does that beat the key
// handover? Shared by pickup-watch (which notices), agent-triage (which
// checks again before proposing anything) and driver-chat.
import { driveTime, kmBetween, type Drive } from "./google.ts";

export type PickupContext = {
  now: string;
  vehicle: { id: string; label: string; order_ref: string | null; status: string; lat: number | null; lng: number | null };
  site: {
    id: string; name: string; city: string; lat: number; lng: number; timezone: string;
    opening_hours: Record<string, string | null>; closes_at: string | null;
    key_handover: "staff_only" | "key_box" | "unknown"; access_note: string;
  } | null;
  driver: { id: string; full_name: string; lat: number | null; lng: number | null; position_at: string | null } | null;
  trip: {
    id: string; mode: string; service: string; from_name: string; to_name: string; to_lat: number; to_lng: number;
    scheduled_arrival: string; delay_minutes: number; expected_arrival: string; simulated: boolean;
  } | null;
};

export type Eta = {
  vehicle_id: string;
  driver: string | null;
  eta: string | null;
  closes_at: string | null;
  in_time: boolean | null;
  minutes_late: number;
  key_handover: string | null;
  basis: string;
  steps: string[];
  drive: Drive | null;
  /** Where the driver will be when they give up: the trip's destination, else their position. */
  ends_at: { name: string; lat: number; lng: number } | null;
};

export const hhmm = (iso: string | Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso));

export async function computeEta(ctx: PickupContext): Promise<Eta> {
  const base = { vehicle_id: ctx.vehicle.id, driver: ctx.driver?.full_name ?? null, closes_at: ctx.site?.closes_at ?? null, key_handover: ctx.site?.key_handover ?? null };
  const empty = (basis: string): Eta => ({ ...base, eta: null, in_time: null, minutes_late: 0, basis, steps: [basis], drive: null, ends_at: null });
  if (!ctx.site) return empty("No pickup site recorded for this car.");
  if (!ctx.driver) return empty("No driver on this car.");
  const site = ctx.site;
  const tz = site.timezone;
  const steps: string[] = [];
  let eta: Date;
  let drive: Drive;
  let basis: string;
  let ends_at: Eta["ends_at"];

  if (ctx.trip) {
    const t = ctx.trip;
    const arrive = new Date(t.expected_arrival);
    drive = await driveTime(ctx.vehicle.id, { lat: t.to_lat, lng: t.to_lng }, site, arrive);
    eta = new Date(arrive.getTime() + drive.minutes * 60_000);
    steps.push(`${t.service} due at ${t.to_name} ${hhmm(t.scheduled_arrival, tz)} + ${t.delay_minutes} min delay = ${hhmm(arrive, tz)}`);
    steps.push(`${t.to_name} → ${site.name}: ${drive.minutes} min, ${drive.km} km by road (${drive.source === "google" ? "Google" : "estimate"}) = ${hhmm(eta, tz)}`);
    // The train cannot be faster than driving straight from where the driver is now.
    if (ctx.driver.lat != null && ctx.driver.lng != null) {
      const direct = await driveTime(ctx.vehicle.id, { lat: ctx.driver.lat, lng: ctx.driver.lng }, site);
      const floor = new Date(Date.now() + direct.minutes * 60_000);
      steps.push(`From the driver's position now (${Math.round(kmBetween({ lat: ctx.driver.lat, lng: ctx.driver.lng }, site))} km away) it is at least ${direct.minutes} min by road`);
      if (floor > eta) eta = floor;
    }
    basis = `${t.service} +${t.delay_minutes} min, then ${drive.minutes} min drive (${drive.source === "google" ? "Google" : "estimate"})`;
    ends_at = { name: t.to_name, lat: t.to_lat, lng: t.to_lng };
  } else if (ctx.driver.lat != null && ctx.driver.lng != null) {
    drive = await driveTime(ctx.vehicle.id, { lat: ctx.driver.lat, lng: ctx.driver.lng }, site);
    eta = new Date(Date.now() + drive.minutes * 60_000);
    steps.push(`Driver's position → ${site.name}: ${drive.minutes} min, ${drive.km} km by road (${drive.source === "google" ? "Google" : "estimate"}) = ${hhmm(eta, tz)}`);
    basis = `${drive.minutes} min drive from the driver's position (${drive.source === "google" ? "Google" : "estimate"})`;
    ends_at = { name: "the driver's position", lat: ctx.driver.lat, lng: ctx.driver.lng };
  } else {
    return empty("The driver's position is not known.");
  }
  if (drive.note) steps.push(`Note: ${drive.note}`);

  let in_time: boolean | null;
  let minutes_late = 0;
  if (site.key_handover === "key_box") {
    in_time = true;
    steps.push(`${site.name} has a key box, so keys can be collected after closing`);
  } else if (!site.closes_at) {
    in_time = null;
    steps.push(`${site.name}'s closing time is not recorded`);
  } else {
    const closes = new Date(site.closes_at);
    in_time = eta <= closes;
    minutes_late = Math.max(0, Math.round((eta.getTime() - closes.getTime()) / 60_000));
    steps.push(`${site.name} hands keys over ${site.key_handover === "staff_only" ? "in person only" : "(method not recorded)"} until ${hhmm(closes, tz)}: ${in_time ? "in time" : `misses by ${minutes_late} min`}`);
  }
  return { ...base, eta: eta.toISOString(), in_time, minutes_late, basis, steps, drive, ends_at };
}

// deno-lint-ignore no-explicit-any
type Db = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: any; error: { message: string } | null }> };

export async function loadPickupContext(db: Db, vehicleId: string): Promise<PickupContext> {
  const { data, error } = await db.rpc("agent_pickup_context", { p_vehicle_id: vehicleId });
  if (error) throw new Error(`agent_pickup_context: ${error.message}`);
  if (!data) throw new Error("no such vehicle");
  return data as PickupContext;
}

/** What the check_driver_eta tool returns to a model. */
export async function driverEtaReport(ctx: PickupContext) {
  const eta = await computeEta(ctx);
  const tz = ctx.site?.timezone ?? "Europe/Berlin";
  return {
    ...eta,
    eta_local: eta.eta ? hhmm(eta.eta, tz) : null,
    closes_local: eta.closes_at ? hhmm(eta.closes_at, tz) : null,
    timezone: tz,
    driver_position: ctx.driver ? { lat: ctx.driver.lat, lng: ctx.driver.lng, at: ctx.driver.position_at } : null,
    trip: ctx.trip,
  };
}

/** What the check_key_pickup tool returns to a model. */
export function keyPickupReport(ctx: PickupContext) {
  if (!ctx.site) return { error: "No pickup site recorded for this car." };
  const s = ctx.site;
  const closes = s.closes_at ? hhmm(s.closes_at, s.timezone) : null;
  return {
    site: s.name,
    city: s.city,
    opening_hours: s.opening_hours,
    closes_today_local: closes,
    closes_at: s.closes_at,
    key_handover: s.key_handover,
    after_hours_pickup_possible: s.key_handover === "key_box",
    access_note: s.access_note,
    verdict: s.key_handover === "staff_only"
      ? `Keys are handed over in person by staff, so nothing can be collected after ${closes ?? "closing"}`
      : s.key_handover === "key_box"
      ? "A key box allows collection after closing"
      : "The record does not say how keys are handed over; do not rely on a late collection",
  };
}

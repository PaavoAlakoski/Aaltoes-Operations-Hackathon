// Google Maps for the edge functions: drive times (Routes API) and hotels
// nearby (Places API, New). The key is the GOOGLE_MAPS_API_KEY function
// secret. Without it, or when Google refuses a call, drive times fall back to
// the same estimate the SQL side uses (straight line x 1.25 at 75 km/h) and
// hotels come back empty. Every result says which source it came from, so
// the agent can say so. Google is paid per request, so drive times and hotels
// are only for the demo cars; every other car gets the estimate. Route lines
// (routePath) are for every car: each is asked once and kept in route_cache.

export type LatLng = { lat: number; lng: number };
export type Drive = { minutes: number; km: number; source: "google" | "estimate"; note?: string };
export type Hotel = {
  place_id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  maps_url: string | null;
  km_straight: number | null;
};

const key = () => Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "";

/**
 * The cars that ask Google for drive times and hotels: Elias Halverick's
 * (simulate_train_delay) and Leo Quellford's (the ferry-miss demo).
 */
export const GOOGLE_VEHICLE_IDS = new Set(["veh-01024", "veh-00584"]);
const NOT_DEMO = "Google is only used for the demo cars";
const isDemo = (vehicleId: string) => GOOGLE_VEHICLE_IDS.has(vehicleId);

export function kmBetween(a: LatLng, b: LatLng): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function estimate(a: LatLng, b: LatLng, note: string): Drive {
  const km = kmBetween(a, b) * 1.25;
  return { minutes: Math.round((km / 75) * 60), km: Math.round(km * 10) / 10, source: "estimate", note };
}

const waypoint = (p: LatLng) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
const seconds = (d: string | undefined) => Number(String(d ?? "0s").replace("s", ""));

/** Drive time from a to b, leaving at departAt (now if missing or past). */
export async function driveTime(vehicleId: string, a: LatLng, b: LatLng, departAt?: Date): Promise<Drive> {
  if (!isDemo(vehicleId)) return estimate(a, b, NOT_DEMO);
  if (!key()) return estimate(a, b, "GOOGLE_MAPS_API_KEY is not set");
  const body: Record<string, unknown> = {
    origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
    destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
  };
  // Google wants a departure time in the future; leave it out for "now".
  if (departAt && departAt.getTime() > Date.now() + 60_000) body.departureTime = departAt.toISOString();
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "routes.duration,routes.distanceMeters" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return estimate(a, b, `Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const route = (await res.json()).routes?.[0];
    if (!route) return estimate(a, b, "Routes API found no route");
    return { minutes: Math.round(seconds(route.duration) / 60), km: Math.round((route.distanceMeters ?? 0) / 100) / 10, source: "google" };
  } catch (e) {
    return estimate(a, b, `Routes API: ${String(e).slice(0, 200)}`);
  }
}

/** Drive times from each origin to one destination, in the origins' order. */
export async function driveTimes(vehicleId: string, origins: LatLng[], b: LatLng): Promise<Drive[]> {
  if (origins.length === 0) return [];
  const fallback = (note: string) => origins.map((a) => estimate(a, b, note));
  if (!isDemo(vehicleId)) return fallback(NOT_DEMO);
  if (!key()) return fallback("GOOGLE_MAPS_API_KEY is not set");
  try {
    const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key(),
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition",
      },
      body: JSON.stringify({ origins: origins.map(waypoint), destinations: [waypoint(b)], travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE" }),
    });
    if (!res.ok) return fallback(`Route Matrix ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const rows = (await res.json()) as Array<{ originIndex?: number; duration?: string; distanceMeters?: number; condition?: string }>;
    return origins.map((a, i) => {
      const r = rows.find((x) => (x.originIndex ?? 0) === i);
      if (!r || r.condition !== "ROUTE_EXISTS") return estimate(a, b, "Route Matrix found no route");
      return { minutes: Math.round(seconds(r.duration) / 60), km: Math.round((r.distanceMeters ?? 0) / 100) / 10, source: "google" as const };
    });
  } catch (e) {
    return fallback(`Route Matrix: ${String(e).slice(0, 200)}`);
  }
}

/** Hotels within radius metres of a point, nearest first. */
export async function hotelsNear(vehicleId: string, p: LatLng, radius = 3000): Promise<{ hotels: Hotel[]; source: "google" | "none"; note?: string }> {
  if (!isDemo(vehicleId)) return { hotels: [], source: "none", note: `${NOT_DEMO}, so no hotels could be looked up` };
  if (!key()) return { hotels: [], source: "none", note: "GOOGLE_MAPS_API_KEY is not set, so no hotels could be looked up" };
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key(),
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.googleMapsUri",
      },
      body: JSON.stringify({
        includedTypes: ["hotel"],
        maxResultCount: 5,
        rankPreference: "DISTANCE",
        locationRestriction: { circle: { center: { latitude: p.lat, longitude: p.lng }, radius } },
      }),
    });
    if (!res.ok) return { hotels: [], source: "none", note: `Places API ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const places = ((await res.json()).places ?? []) as Array<Record<string, any>>;
    return {
      source: "google",
      hotels: places.map((x) => {
        const lat = x.location?.latitude ?? null;
        const lng = x.location?.longitude ?? null;
        return {
          place_id: String(x.id),
          name: String(x.displayName?.text ?? "Hotel"),
          address: String(x.formattedAddress ?? ""),
          lat,
          lng,
          rating: typeof x.rating === "number" ? x.rating : null,
          maps_url: x.googleMapsUri ?? null,
          km_straight: lat != null && lng != null ? Math.round(kmBetween(p, { lat, lng }) * 10) / 10 : null,
        };
      }),
    };
  } catch (e) {
    return { hotels: [], source: "none", note: `Places API: ${String(e).slice(0, 200)}` };
  }
}

export type RoutePath = { path: [number, number][]; km: number; minutes: number; source: "google" | "estimate"; note?: string };

/** Google's encoded polyline as [lng, lat] pairs. */
function decodePolyline(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

/** Keeps a point roughly every minKm along the path, and always the last one. */
function thin(path: [number, number][], minKm: number): [number, number][] {
  if (path.length < 3) return path;
  const kept = [path[0]];
  for (const p of path.slice(1, -1)) {
    const last = kept[kept.length - 1];
    if (kmBetween({ lat: last[1], lng: last[0] }, { lat: p[1], lng: p[0] }) >= minKm) kept.push(p);
  }
  kept.push(path[path.length - 1]);
  return kept;
}

/**
 * The road from a to b as a line to draw and drive along, for any car. Without
 * traffic, so it is the cheaper Routes request; callers cache it (route_cache).
 */
export async function routePath(vehicleId: string, a: LatLng, b: LatLng): Promise<RoutePath> {
  const straight = (note: string): RoutePath => {
    const e = estimate(a, b, note);
    return { path: [[a.lng, a.lat], [b.lng, b.lat]], km: e.km, minutes: e.minutes, source: "estimate", note };
  };
  if (!key()) return straight("GOOGLE_MAPS_API_KEY is not set");
  try {
    const res = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key(),
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
      },
      body: JSON.stringify({
        origin: waypoint(a).waypoint,
        destination: waypoint(b).waypoint,
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_UNAWARE",
        polylineQuality: "HIGH_QUALITY",
      }),
    });
    if (!res.ok) return straight(`Routes API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const route = (await res.json()).routes?.[0];
    if (!route?.polyline?.encodedPolyline) return straight("Routes API found no route");
    return {
      path: thin(decodePolyline(route.polyline.encodedPolyline), 0.3),
      km: Math.round((route.distanceMeters ?? 0) / 100) / 10,
      minutes: Math.round(seconds(route.duration) / 60),
      source: "google",
    };
  } catch (e) {
    return straight(`Routes API: ${String(e).slice(0, 200)}`);
  }
}

// Approximate city-centre coordinates for every city in addresses.city and drivers.home_city.
// The packet has no coordinates. Distances are straight-line estimates between city centres:
// they rank options, they are not road distances and not live positions.

export type LatLon = { lat: number; lon: number }

const COORDS: Record<string, LatLon> = {
  Aalborg: { lat: 57.0488, lon: 9.9217 },
  Aarhus: { lat: 56.1629, lon: 10.2039 },
  Antwerp: { lat: 51.2194, lon: 4.4025 },
  Berlin: { lat: 52.52, lon: 13.405 },
  Bordeaux: { lat: 44.8378, lon: -0.5792 },
  Cologne: { lat: 50.9375, lon: 6.9603 },
  Copenhagen: { lat: 55.6761, lon: 12.5683 },
  Düsseldorf: { lat: 51.2277, lon: 6.7735 },
  Espoo: { lat: 60.2055, lon: 24.6559 },
  Frankfurt: { lat: 50.1109, lon: 8.6821 },
  Ghent: { lat: 51.0543, lon: 3.7174 },
  Gothenburg: { lat: 57.7089, lon: 11.9746 },
  Graz: { lat: 47.0707, lon: 15.4395 },
  Hamburg: { lat: 53.5511, lon: 9.9937 },
  Helsinki: { lat: 60.1699, lon: 24.9384 },
  Jyväskylä: { lat: 62.2415, lon: 25.7209 },
  Lahti: { lat: 60.9827, lon: 25.6612 },
  Leipzig: { lat: 51.3397, lon: 12.3731 },
  Lille: { lat: 50.6292, lon: 3.0573 },
  Lyon: { lat: 45.764, lon: 4.8357 },
  Malmö: { lat: 55.605, lon: 13.0038 },
  Marseille: { lat: 43.2965, lon: 5.3698 },
  Munich: { lat: 48.1351, lon: 11.582 },
  Odense: { lat: 55.4038, lon: 10.4024 },
  Oulu: { lat: 65.0121, lon: 25.4651 },
  Paris: { lat: 48.8566, lon: 2.3522 },
  Pori: { lat: 61.485, lon: 21.7974 },
  Rotterdam: { lat: 51.9244, lon: 4.4777 },
  Seinäjoki: { lat: 62.7903, lon: 22.8402 },
  Stockholm: { lat: 59.3293, lon: 18.0686 },
  Stuttgart: { lat: 48.7758, lon: 9.1829 },
  Tampere: { lat: 61.4978, lon: 23.761 },
  Turku: { lat: 60.4518, lon: 22.2666 },
  Uppsala: { lat: 59.8586, lon: 17.6389 },
  Vantaa: { lat: 60.2934, lon: 25.0378 },
  Vienna: { lat: 48.2082, lon: 16.3738 },
}

const EARTH_RADIUS_KM = 6371

export function cityCoords(city: string): LatLon | null {
  return COORDS[city.normalize("NFC")] ?? null
}

export function haversineKm(a: LatLon, b: LatLon): number {
  const rad = (deg: number) => (deg * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Straight-line km between two city names, or null with the reason when a city has no coordinates. */
export function cityDistanceKm(from: string, to: string): { km: number } | { km: null; reason: string } {
  const a = cityCoords(from)
  const b = cityCoords(to)
  if (!a) return { km: null, reason: `No coordinates for ${from}` }
  if (!b) return { km: null, reason: `No coordinates for ${to}` }
  return { km: haversineKm(a, b) }
}

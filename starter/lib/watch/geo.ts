import type { LatLng } from "./schema"

const EARTH_KM = 6371
// Used when a position is too far from the planned route to trust the polyline.
export const ROAD_FACTOR = 1.3
export const OFF_ROUTE_KM = 5

const rad = (deg: number) => (deg * Math.PI) / 180

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0])
  const dLng = rad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h))
}

export function routeLengthKm(route: LatLng[]): number {
  let total = 0
  for (let i = 1; i < route.length; i++) total += haversineKm(route[i - 1], route[i])
  return total
}

export type RouteProjection = {
  alongKm: number
  remainingKm: number
  offRouteKm: number
}

// Projects a point onto the route in a local flat approximation, good enough at segment scale.
export function projectOnRoute(point: LatLng, route: LatLng[]): RouteProjection {
  const total = routeLengthKm(route)
  if (route.length < 2) {
    const off = route.length ? haversineKm(point, route[0]) : 0
    return { alongKm: 0, remainingKm: off * ROAD_FACTOR, offRouteKm: off }
  }
  let best = { alongKm: 0, offRouteKm: Number.POSITIVE_INFINITY }
  let walked = 0
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    const segKm = haversineKm(a, b)
    const kx = Math.cos(rad((a[0] + b[0]) / 2))
    const bx = (b[1] - a[1]) * kx
    const by = b[0] - a[0]
    const px = (point[1] - a[1]) * kx
    const py = point[0] - a[0]
    const len2 = bx * bx + by * by
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2))
    const foot: LatLng = [a[0] + by * t, a[1] + (b[1] - a[1]) * t]
    const off = haversineKm(point, foot)
    if (off < best.offRouteKm) best = { alongKm: walked + segKm * t, offRouteKm: off }
    walked += segKm
  }
  return { alongKm: best.alongKm, remainingKm: Math.max(0, total - best.alongKm), offRouteKm: best.offRouteKm }
}

// Distance left to the target. Falls back to straight line × road factor when off route.
export function remainingKm(point: LatLng, route: LatLng[], target: LatLng): { km: number; onRoute: boolean } {
  const projection = projectOnRoute(point, route)
  if (projection.offRouteKm <= OFF_ROUTE_KM) return { km: projection.remainingKm, onRoute: true }
  return { km: haversineKm(point, target) * ROAD_FACTOR, onRoute: false }
}

export function pointAlongRoute(route: LatLng[], km: number): LatLng {
  if (route.length === 0) throw new Error("Route is empty")
  let walked = 0
  for (let i = 1; i < route.length; i++) {
    const segKm = haversineKm(route[i - 1], route[i])
    if (walked + segKm >= km) {
      const t = segKm === 0 ? 0 : (km - walked) / segKm
      const [a, b] = [route[i - 1], route[i]]
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    walked += segKm
  }
  return route[route.length - 1]
}

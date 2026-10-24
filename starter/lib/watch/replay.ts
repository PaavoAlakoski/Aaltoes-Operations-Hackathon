import { pointAlongRoute, routeLengthKm } from "./geo"
import type { LatLng } from "./schema"
import type { ScenarioCar, SpeedZone } from "./mock/scenario"

// Pure car simulator for the demo. Given a car profile and the minutes since the scenario
// started, says where the car is. Deterministic so a demo run can be repeated exactly.

export type Injection = { kind: "jam"; atMin: number; untilMin: number; speedKmh: number } | { kind: "offline"; atMin: number; untilMin: number }

export type CarSample = {
  kmToGo: number
  position: LatLng
  speedKmh: number
  online: boolean
  arrived: boolean
  zone: string | null
}

const STEP_MIN = 0.5

function speedAt(car: ScenarioCar, kmToGo: number, minute: number, injections: Injection[]): { kmh: number; zone: SpeedZone | null } {
  const injected = injections.find((i) => i.kind === "jam" && minute >= i.atMin && minute < i.untilMin)
  if (injected && injected.kind === "jam") return { kmh: injected.speedKmh, zone: { fromKmToGo: kmToGo, toKmToGo: kmToGo, speedKmh: injected.speedKmh, label: "Traffic jam" } }
  const zone = car.zones.find((z) => kmToGo <= z.fromKmToGo && kmToGo > z.toKmToGo) ?? null
  // Small deterministic wobble so live speed is not a flat line.
  const wobble = 1 + 0.05 * Math.sin(minute / 6)
  return { kmh: (zone ? zone.speedKmh : car.cruiseKmh) * wobble, zone }
}

export function sampleCar(car: ScenarioCar, route: LatLng[], minute: number, injections: Injection[] = []): CarSample {
  const total = routeLengthKm(route)
  let kmToGo = Math.min(car.startKmToGo, total)
  let current = speedAt(car, kmToGo, 0, injections)
  for (let t = 0; t < minute && kmToGo > 0; t += STEP_MIN) {
    current = speedAt(car, kmToGo, t, injections)
    kmToGo = Math.max(0, kmToGo - (current.kmh * Math.min(STEP_MIN, minute - t)) / 60)
  }
  const arrived = kmToGo <= 0.05
  const offline = [...car.offline.map((w) => ({ atMin: w.fromMin, untilMin: w.toMin })), ...injections.filter((i) => i.kind === "offline")]
    .some((w) => minute >= w.atMin && minute < w.untilMin)
  return {
    kmToGo,
    position: pointAlongRoute(route, total - kmToGo),
    speedKmh: arrived ? 0 : current.kmh,
    online: !offline,
    arrived,
    zone: current.zone?.label ?? null,
  }
}

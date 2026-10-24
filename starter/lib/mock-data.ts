import "server-only"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { DATASET_DIR, loadDataset } from "./recovery/dataset"
import { cityCoords, haversineKm } from "./recovery/geo"
import type { SourceRef } from "./recovery/types"

// The train-delay "double recovery" scenario.
//
// Real, from the dataset: the order (CD-420992), its pickup dealer (Kervalin Frankfurt) with its
// opening hours and handover rule, the assigned driver (Cole Mervalen) and the standby drivers.
// Mock, and labelled so wherever it is shown: the train and its telemetry, hotels, and tomorrow's
// driver-market jobs. The snapshot's published offers all expire by 22 Oct, so "tomorrow" has none.

export type KeyHandoverMethod = "PERSONAL_ONLY" | "KEY_BOX" | "UNKNOWN"

export type Dealer = {
  id: string
  name: string
  city: string
  timezone: string
  /** Local closing time on the pickup day, e.g. "19:00". Null when the hours are not recorded. */
  closeTime: string | null
  keyHandoverMethod: KeyHandoverMethod
  /** The words in the record that the handover method was read from. */
  evidence: string[]
  sources: SourceRef[]
}

export type DriverStatus = "TRAVELLING_TO_PICKUP" | "AVAILABLE" | "ON_JOB" | "OFF_DUTY"

export type Driver = {
  id: string
  name: string
  homeCity: string
  status: DriverStatus
  currentLocation: { label: string; city: string | null; lat: number; lng: number; basis: "TRAIN_TELEMETRY_MOCK" | "HOME_CITY" }
  sources: SourceRef[]
}

export type MarketJob = {
  id: string
  pickupCity: string
  deliveryCity: string
  /** ISO times; local times are shown in the pickup city's zone. */
  pickupWindow: { start: string; end: string; timezone: string }
  feeEur: number
  label: "MOCK DRIVER-MARKET JOB"
}

export type Hotel = { id: string; name: string; city: string; nightlyEur: number; walkMinFromStation: number; label: "MOCK HOTEL QUOTE" }

export type TrainTelemetry = {
  label: "MOCK TRAIN TELEMETRY"
  operator: string
  train: string
  from: string
  to: string
  observedAt: string
  position: { label: string; lat: number; lng: number }
  stationaryForMin: number
  scheduledArrivalAt: string
  delayMin: number
  delayReason: string
  /** Station to dealer by taxi, mock. */
  transferMin: number
}

export const SCENARIO = {
  id: "train-delay-cd-420992",
  title: "Driver's train delayed on the way to a Frankfurt pickup",
  orderId: "ord-00992",
  driverId: "drv-260",
  /** The day the scenario plays out: the pickup day, the day after the snapshot. */
  day: "2026-10-22",
  /** "Tomorrow" for the stranded driver. */
  nextDay: "2026-10-23",
} as const

export const TRAIN: TrainTelemetry = {
  label: "MOCK TRAIN TELEMETRY",
  operator: "Northrail",
  train: "Northrail IC 2207",
  from: "Hamburg",
  to: "Frankfurt",
  observedAt: "2026-10-22T08:40:00Z",
  position: { label: "Stopped on the line north of Göttingen", lat: 51.62, lng: 9.95 },
  stationaryForMin: 95,
  scheduledArrivalAt: "2026-10-22T08:55:00Z",
  delayMin: 480,
  delayReason: "Overhead line failure; the operator's revised estimate is 8 hours late",
  transferMin: 25,
}

export const HOTELS: Hotel[] = [
  { id: "hotel-fra-1", name: "Mainbrücke Rooms", city: "Frankfurt", nightlyEur: 96, walkMinFromStation: 6, label: "MOCK HOTEL QUOTE" },
  { id: "hotel-fra-2", name: "Westend Lodge", city: "Frankfurt", nightlyEur: 84, walkMinFromStation: 14, label: "MOCK HOTEL QUOTE" },
  { id: "hotel-cgn-1", name: "Rheinufer Stay", city: "Cologne", nightlyEur: 89, walkMinFromStation: 5, label: "MOCK HOTEL QUOTE" },
]

const job = (id: string, from: string, to: string, start: string, end: string, feeEur: number): MarketJob =>
  ({ id, pickupCity: from, deliveryCity: to, pickupWindow: { start, end, timezone: "Europe/Berlin" }, feeEur, label: "MOCK DRIVER-MARKET JOB" })

export const DRIVER_MARKET: MarketJob[] = [
  job("mkt-2301", "Frankfurt", "Hamburg", "2026-10-23T06:00:00Z", "2026-10-23T09:00:00Z", 420),
  job("mkt-2302", "Stuttgart", "Munich", "2026-10-23T08:00:00Z", "2026-10-23T11:00:00Z", 310),
  job("mkt-2303", "Cologne", "Rotterdam", "2026-10-23T07:00:00Z", "2026-10-23T10:00:00Z", 290),
  job("mkt-2304", "Frankfurt", "Vienna", "2026-10-23T12:00:00Z", "2026-10-23T15:00:00Z", 560),
  job("mkt-2401", "Leipzig", "Berlin", "2026-10-24T07:00:00Z", "2026-10-24T10:00:00Z", 260),
]

// ---- Readers over the dataset ------------------------------------------------------------------

type RawSite = {
  id: string; name: string; city: string; timezone: string; handover_mode?: string; access_note?: string
  pickup_access_note?: string; release_document_rule?: string; opening_hours?: Record<string, string | null> | null
}
type RawEndpoint = { order_id: string; boundary: string; access_instruction?: string | null; id: string }

async function jsonl<T>(name: string): Promise<T[]> {
  const text = await readFile(path.join(DATASET_DIR, `${name}.jsonl`), "utf8")
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as T)
}

function weekdayKey(day: string, timezone: string): "mon_fri" | "sat" | "sun" {
  const name = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(new Date(`${day}T12:00:00Z`))
  return name === "Sat" ? "sat" : name === "Sun" ? "sun" : "mon_fri"
}

const PERSONAL = /\b(staff|staffed|reception|security|desk|escort|driver id|in person)\b/i
const KEY_BOX = /\b(key ?box|key safe|lock ?box|after-hours drop allowed|self-service)\b/i

/** The dealer where the car waits, with its closing time on `day` and how keys are handed over. */
export async function getDealer(orderId: string, day: string = SCENARIO.day): Promise<Dealer | null> {
  const ds = await loadDataset()
  const order = ds.orders.find((o) => o.id === orderId || o.reference === orderId)
  if (!order) return null
  const rawOrders = await jsonl<{ id: string; pickup_site_id: string | null }>("orders")
  const siteId = rawOrders.find((o) => o.id === order.id)?.pickup_site_id
  if (!siteId) return null
  const site = (await jsonl<RawSite>("sites")).find((s) => s.id === siteId)
  if (!site) return null
  const endpoint = (await jsonl<RawEndpoint>("order_endpoint_details")).find((e) => e.order_id === order.id && e.boundary === "PICKUP")

  const range = site.opening_hours?.[weekdayKey(day, site.timezone)] ?? null
  const closeTime = range && /-/.test(range) ? range.split("-")[1].trim() : null
  const texts = [
    site.handover_mode ? `Handover mode: ${site.handover_mode.replaceAll("_", " ")}` : null,
    site.pickup_access_note ?? site.access_note ?? null,
    site.release_document_rule ?? null,
    endpoint?.access_instruction ?? null,
  ].filter((t): t is string => Boolean(t))
  const joined = texts.join(" ")
  const keyHandoverMethod: KeyHandoverMethod = KEY_BOX.test(joined) ? "KEY_BOX" : PERSONAL.test(joined) ? "PERSONAL_ONLY" : "UNKNOWN"

  return {
    id: site.id, name: site.name, city: site.city, timezone: site.timezone, closeTime, keyHandoverMethod,
    evidence: [...new Set(texts)],
    sources: [{ table: "sites", id: site.id }, ...(endpoint ? [{ table: "order_endpoint_details", id: endpoint.id }] : [])] as SourceRef[],
  }
}

/** The assigned driver, located by the mock train telemetry. */
export async function getStrandedDriver(driverId: string = SCENARIO.driverId): Promise<Driver | null> {
  const ds = await loadDataset()
  const d = ds.drivers.find((row) => row.id === driverId)
  if (!d) return null
  return {
    id: d.id, name: d.name, homeCity: d.homeCity, status: "TRAVELLING_TO_PICKUP",
    currentLocation: { label: TRAIN.position.label, city: null, lat: TRAIN.position.lat, lng: TRAIN.position.lng, basis: "TRAIN_TELEMETRY_MOCK" },
    sources: d.sources,
  }
}

/** Mock jobs for `day` whose pickup is within `maxKm` of `nearCity`, nearest first. */
export function driverMarketNear(nearCity: string, day: string, maxKm = 250, homeCity?: string): (MarketJob & { distanceKm: number; endsNearHome: boolean })[] {
  const from = cityCoords(nearCity)
  if (!from) return []
  const home = homeCity ? cityCoords(homeCity) : null
  return DRIVER_MARKET
    .filter((j) => j.pickupWindow.start.slice(0, 10) === day)
    .map((j) => {
      const at = cityCoords(j.pickupCity)
      const to = cityCoords(j.deliveryCity)
      return { ...j, distanceKm: at ? Math.round(haversineKm(from, at)) : Number.POSITIVE_INFINITY, endsNearHome: Boolean(home && to && haversineKm(home, to) < 50) }
    })
    .filter((j) => j.distanceKm <= maxKm)
    .sort((a, b) => Number(b.endsNearHome) - Number(a.endsNearHome) || a.distanceKm - b.distanceKm)
}

export function hotelsIn(city: string): Hotel[] {
  return HOTELS.filter((h) => h.city === city).sort((a, b) => a.walkMinFromStation - b.walkMinFromStation)
}

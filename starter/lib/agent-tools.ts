import "server-only"
import { loadDataset, type Dataset } from "./recovery/dataset"
import { tool } from "ai"
import { z } from "zod"
import { SCENARIO, TRAIN, driverMarketNear, getDealer, getStrandedDriver, hotelsIn, type KeyHandoverMethod } from "./mock-data"
import { cityCoords, cityDistanceKm, haversineKm } from "./recovery/geo"
import { OPEN_ALERT_STATUSES, RECOVERY_SIGNALS } from "./recovery/labels"
import { dayKey, fmtDay } from "./present/time"
import type {
  AlertRecord,
  AssignmentRecord,
  CaseList,
  DriverRecord,
  EventRecord,
  Location,
  Money,
  OfferRecord,
  OrderRecord,
  ProposalRecord,
  RecoverySignal,
  SourceRef,
  Window,
} from "./recovery/types"

// Tools for an LLM tool-use loop. Each tool is { name, description, input_schema, run(input) }.
// The typed functions below are what the plan builder calls; the tool objects wrap them with JSON input.

export const DEFAULT_MAX_KM = 250
const DEFAULT_LIMIT = 5
const ACTIVE = new Set(["ASSIGNED", "IN_PROGRESS"])
const OPEN = new Set<string>(OPEN_ALERT_STATUSES)
const SIGNALS = new Set<string>(RECOVERY_SIGNALS)

const STANDBY_CAVEAT = "Availability is not confirmed. Ask the driver before offering this pickup. Distance is straight-line between city centres, from the home city."
const OFFER_CAVEAT = "A published offer is not an assignment. Ask the driver whether they can take it. Booking needs their acceptance and a person's approval."

export type Exclusion = { id: string; reason: string }

export type StandbyCandidate = {
  driverId: string
  name: string
  distanceKm: number
  status: "available"
  statusBasis: string
  location: Location
  sources: SourceRef[]
}

export type StandbyResult = {
  snapshotAt: string
  order: { id: string; reference: string; pickupCity: string; pickupCountry: string; pickupSlot: Window | null }
  maxKm: number
  withinRadius: number
  candidates: StandbyCandidate[]
  excluded: Exclusion[]
  caveat: string
  sources: SourceRef[]
}

export type OfferOption = {
  offerId: string
  orderId: string
  orderRef: string
  route: string
  pickupCity: string
  deliveryCity: string
  pickupSlot: Window | null
  fee: Money
  expiresAt: string
  distanceKm: number
  deliveryKmFromHome: number | null
  sources: SourceRef[]
}

export type OfferResult = {
  snapshotAt: string
  driver: { id: string; name: string; homeCity: string; from: Location; earliestAvailableAt: string | null }
  maxKm: number
  withinRadius: number
  offers: OfferOption[]
  excluded: Exclusion[]
  caveat: string
}

export type CaseDetail = {
  order: OrderRecord
  assignment: AssignmentRecord | null
  driver: DriverRecord | null
  alert: AlertRecord | null
  openAlerts: AlertRecord[]
  events: EventRecord[]
  proposals: ProposalRecord[]
  sources: SourceRef[]
}

function findOrder(ds: Dataset, key: string): OrderRecord | undefined {
  return ds.orders.find((order) => order.id === key || order.reference === key)
}

/** Available drivers whose home city is near the order's pickup city, nearest first. */
export async function findStandbyDriver(input: { orderId: string; maxKm?: number; limit?: number }): Promise<StandbyResult | null> {
  const ds = await loadDataset()
  const order = findOrder(ds, input.orderId)
  if (!order) return null
  const maxKm = input.maxKm ?? DEFAULT_MAX_KM
  const committed = new Set(ds.assignments.filter((row) => row.orderId === order.id && ACTIVE.has(row.status)).map((row) => row.driverId))
  const within: StandbyCandidate[] = []
  const excluded: Exclusion[] = []
  for (const driver of ds.drivers) {
    if (driver.status !== "available" || committed.has(driver.id)) continue
    const distance = cityDistanceKm(driver.currentLocation.city, order.dealerCity)
    if (distance.km === null) { excluded.push({ id: driver.id, reason: distance.reason }); continue }
    const km = Math.round(distance.km)
    if (km > maxKm) continue
    within.push({ driverId: driver.id, name: driver.name, distanceKm: km, status: "available", statusBasis: driver.statusBasis, location: driver.currentLocation, sources: driver.sources })
  }
  within.sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
  return {
    snapshotAt: ds.snapshotAt,
    order: { id: order.id, reference: order.reference, pickupCity: order.dealerCity, pickupCountry: order.dealerCountry, pickupSlot: order.pickupSlot },
    maxKm,
    withinRadius: within.length,
    candidates: within.slice(0, input.limit ?? DEFAULT_LIMIT),
    excluded,
    caveat: STANDBY_CAVEAT,
    sources: order.sources,
  }
}

/** Published, unexpired open offers a driver could take after they are free. */
export async function findNewOrderForStrandedDriver(input: { driverId: string; maxKm?: number; limit?: number }): Promise<OfferResult | null> {
  const ds = await loadDataset()
  const driver = ds.drivers.find((row) => row.id === input.driverId)
  if (!driver) return null
  const maxKm = input.maxKm ?? DEFAULT_MAX_KM
  const snapshot = Date.parse(ds.snapshotAt)
  const own = new Set(ds.assignments.filter((row) => row.driverId === driver.id && ACTIVE.has(row.status)).map((row) => row.orderId))
  const earliest = driver.earliestAvailableAt ? Date.parse(driver.earliestAvailableAt) : null
  const within: OfferOption[] = []
  const excluded: Exclusion[] = []
  for (const offer of ds.offers) {
    if (offer.status !== "PUBLISHED" || offer.visibility === "DIRECTED") continue
    if (!(Date.parse(offer.expiresAt) > snapshot)) continue
    if (own.has(offer.orderId)) continue
    if (!offer.pickupCity || !offer.deliveryCity) { excluded.push({ id: offer.id, reason: "Route not recorded" }); continue }
    const fromDriver = cityDistanceKm(driver.currentLocation.city, offer.pickupCity)
    if (fromDriver.km === null) { excluded.push({ id: offer.id, reason: fromDriver.reason }); continue }
    const km = Math.round(fromDriver.km)
    if (km > maxKm) continue
    if (earliest !== null) {
      if (!offer.pickupSlot) { excluded.push({ id: offer.id, reason: "No pickup slot recorded, so the driver's timing cannot be checked" }); continue }
      if (Date.parse(offer.pickupSlot.start) < earliest) { excluded.push({ id: offer.id, reason: "Pickup slot starts before the driver is free" }); continue }
    }
    const home = cityDistanceKm(driver.homeCity, offer.deliveryCity)
    within.push({
      offerId: offer.id,
      orderId: offer.orderId,
      orderRef: offer.orderRef,
      route: `${offer.pickupCity} → ${offer.deliveryCity}`,
      pickupCity: offer.pickupCity,
      deliveryCity: offer.deliveryCity,
      pickupSlot: offer.pickupSlot,
      fee: offer.fee,
      expiresAt: offer.expiresAt,
      distanceKm: km,
      deliveryKmFromHome: home.km === null ? null : Math.round(home.km),
      sources: offer.sources,
    })
  }
  within.sort((a, b) => a.distanceKm - b.distanceKm || (a.deliveryKmFromHome ?? 1e9) - (b.deliveryKmFromHome ?? 1e9) || a.orderRef.localeCompare(b.orderRef))
  return {
    snapshotAt: ds.snapshotAt,
    driver: { id: driver.id, name: driver.name, homeCity: driver.homeCity, from: driver.currentLocation, earliestAvailableAt: driver.earliestAvailableAt },
    maxKm,
    withinRadius: within.length,
    offers: within.slice(0, input.limit ?? DEFAULT_LIMIT),
    excluded,
    caveat: OFFER_CAVEAT,
  }
}

/** One order's recovery context: facts, timeline, driver, open alert and agent proposals. */
export async function getRecoveryCase(input: { orderId: string }): Promise<CaseDetail | null> {
  const ds = await loadDataset()
  const order = findOrder(ds, input.orderId)
  if (!order) return null
  const assignment = ds.assignments.find((row) => row.orderId === order.id && row.status === "ASSIGNED")
    ?? ds.assignments.find((row) => row.orderId === order.id && ACTIVE.has(row.status))
    ?? null
  const driver = assignment ? ds.drivers.find((row) => row.id === assignment.driverId) ?? null : null
  const openAlerts = ds.alerts.filter((row) => row.orderId === order.id && OPEN.has(row.status))
  const alert = openAlerts.find((row) => SIGNALS.has(row.signal)) ?? openAlerts[0] ?? null
  return {
    order,
    assignment,
    driver,
    alert,
    openAlerts,
    events: ds.events.filter((row) => row.orderId === order.id),
    proposals: ds.proposals.filter((row) => row.orderId === order.id),
    sources: order.sources,
  }
}

function dayNumber(key: string): number {
  return Date.parse(`${key}T00:00:00Z`) / 86400000
}

function dayPhrase(slot: Window | null, snapshotAt: string): string {
  if (!slot) return "the"
  const days = dayNumber(dayKey(slot.start, slot.timezone)) - dayNumber(dayKey(snapshotAt, slot.timezone))
  if (days === 0) return "today's"
  if (days === 1) return "tomorrow's"
  return `the ${fmtDay(slot.start, slot.timezone)}`
}

function caseReason(signal: string, order: OrderRecord, snapshotAt: string): string {
  if (signal === "DRIVER_AVAILABILITY_RISK") return "Driver may be too unwell to collect"
  return `Driver can't reach ${order.dealerCity} for ${dayPhrase(order.pickupSlot, snapshotAt)} pickup`
}

/** Orders with an open or acknowledged driver risk and a booked driver. One entry per order. */
export async function listRecoveryCases(): Promise<CaseList> {
  const ds = await loadDataset()
  const seen = new Map<string, CaseList["cases"][number]>()
  for (const alert of ds.alerts) {
    if (!OPEN.has(alert.status) || !SIGNALS.has(alert.signal) || seen.has(alert.orderId)) continue
    const order = ds.orders.find((row) => row.id === alert.orderId)
    const assignment = ds.assignments.find((row) => row.orderId === alert.orderId && row.status === "ASSIGNED")
    if (!order || !assignment) continue
    const driver = ds.drivers.find((row) => row.id === assignment.driverId)
    seen.set(order.id, {
      id: order.id,
      reference: order.reference,
      carMake: order.carMake,
      carModel: order.carModel,
      signal: alert.signal as RecoverySignal,
      reason: caseReason(alert.signal, order, ds.snapshotAt),
      pickupCity: order.dealerCity,
      pickupSlot: order.pickupSlot ? { start: order.pickupSlot.start, end: order.pickupSlot.end, timezone: order.pickupSlot.timezone } : null,
      driverName: driver?.name ?? null,
      alertId: alert.id,
    })
  }
  const cases = [...seen.values()].sort((a, b) => (a.pickupSlot?.start ?? "￿").localeCompare(b.pickupSlot?.start ?? "￿") || a.reference.localeCompare(b.reference))
  return { snapshotAt: ds.snapshotAt, checkedOrders: ds.orders.length, cases }
}

// ── Tool objects for a tool-use loop ─────────────────────────────────────────

export type AgentTool = {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, { type: "string" | "number"; description: string }>
    required: string[]
    additionalProperties: false
  }
  run: (input: Record<string, unknown>) => Promise<unknown>
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${key}" must be a non-empty string`)
  return value.trim()
}

function readNumber(input: Record<string, unknown>, key: string, max: number): number | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) throw new Error(`"${key}" must be a number from 1 to ${max}`)
  return value
}

const standbyTool: AgentTool = {
  name: "find_standby_driver",
  description: "Find available drivers whose home city is near the pickup city of an order, nearest first. Use when a car has no driver it can reach the pickup with. Availability is not confirmed: ask the driver before offering the pickup.",
  input_schema: {
    type: "object",
    properties: {
      orderId: { type: "string", description: "Order id (ord-...) or reference (CD-...)" },
      maxKm: { type: "number", description: "Search radius in km, default 250" },
      limit: { type: "number", description: "Maximum candidates, default 5" },
    },
    required: ["orderId"],
    additionalProperties: false,
  },
  run: async (input) => {
    const result = await findStandbyDriver({
      orderId: readString(input, "orderId"),
      maxKm: readNumber(input, "maxKm", 1000),
      limit: readNumber(input, "limit", 20),
    })
    return result ?? { found: false, message: "No order matches that id or reference." }
  },
}

const offerTool: AgentTool = {
  name: "find_new_order_for_stranded_driver",
  description: "Find published open offers a driver could take once they are free: not expired at the snapshot, pickup within the radius of the driver's planned release city, and pickup slot not before the driver's earliest departure. A published offer is not an assignment.",
  input_schema: {
    type: "object",
    properties: {
      driverId: { type: "string", description: "Driver id (drv-...)" },
      maxKm: { type: "number", description: "Search radius in km, default 250" },
      limit: { type: "number", description: "Maximum offers, default 5" },
    },
    required: ["driverId"],
    additionalProperties: false,
  },
  run: async (input) => {
    const result = await findNewOrderForStrandedDriver({
      driverId: readString(input, "driverId"),
      maxKm: readNumber(input, "maxKm", 1000),
      limit: readNumber(input, "limit", 20),
    })
    return result ?? { found: false, message: "No driver matches that id." }
  },
}

const caseTool: AgentTool = {
  name: "get_recovery_case",
  description: "Get one order's recovery context: order facts, timeline of alerts, messages and operations, the assigned driver, the open alert, and agent proposals with their reviews.",
  input_schema: {
    type: "object",
    properties: { orderId: { type: "string", description: "Order id (ord-...) or reference (CD-...)" } },
    required: ["orderId"],
    additionalProperties: false,
  },
  run: async (input) => {
    const result = await getRecoveryCase({ orderId: readString(input, "orderId") })
    return result ?? { found: false, message: "No order matches that id or reference." }
  },
}

export const TOOLS: AgentTool[] = [standbyTool, offerTool, caseTool]

export function getTool(name: string): AgentTool | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

// ---- Double recovery: the train-delay scenario, as Vercel AI SDK tools ------------------------
//
// The typed functions compute every time and number; the model only reads them and writes the
// proposal. generate_reshuffle_proposal checks the model's answer against the same functions and
// sends it back to fix if it disagrees, so a wrong "driverInTime" or an invented id cannot reach a person.

const hhmm = (iso: string, timezone: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(new Date(iso))
const addMin = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60000).toISOString()

/** The instant when the clock in `timezone` shows `time` ("19:00") on `day` ("2026-10-22"). */
function localTimeToUtc(day: string, time: string, timezone: string): string {
  const guess = Date.parse(`${day}T${time}:00Z`)
  const shown = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute)
  }
  return new Date(guess - (shown(guess) - guess)).toISOString()
}

export type TelemetryCheck = {
  label: "MOCK TRAIN TELEMETRY"
  orderRef: string
  driver: { id: string; name: string; status: string; currentLocation: string }
  train: string
  observedAt: string
  stationaryForMin: number
  delayReason: string
  scheduledArrival: string
  revisedArrival: string
  readyAtDealer: string
  readyAtDealerIso: string
  kmToDealerStraightLine: number
  pickupSlot: string | null
  math: string[]
  sources: SourceRef[]
}

export async function checkTelemetry(input: { orderId: string }): Promise<TelemetryCheck | null> {
  const ds = await loadDataset()
  const order = findOrder(ds, input.orderId)
  const driver = await getStrandedDriver(SCENARIO.driverId)
  const dealer = await getDealer(input.orderId)
  if (!order || !driver || !dealer || order.id !== SCENARIO.orderId) return null
  const tz = dealer.timezone
  const revised = addMin(TRAIN.scheduledArrivalAt, TRAIN.delayMin)
  const ready = addMin(revised, TRAIN.transferMin)
  const dealerAt = cityCoords(dealer.city)
  const km = dealerAt ? Math.round(haversineKm({ lat: TRAIN.position.lat, lon: TRAIN.position.lng }, dealerAt)) : -1
  const slot = order.pickupSlot ? `${hhmm(order.pickupSlot.start, tz)}–${hhmm(order.pickupSlot.end, tz)} local on ${order.pickupSlot.start.slice(0, 10)}` : null
  return {
    label: TRAIN.label, orderRef: order.reference,
    driver: { id: driver.id, name: driver.name, status: driver.status, currentLocation: driver.currentLocation.label },
    train: `${TRAIN.train}, ${TRAIN.from} → ${TRAIN.to}`,
    observedAt: `${hhmm(TRAIN.observedAt, tz)} local`,
    stationaryForMin: TRAIN.stationaryForMin,
    delayReason: TRAIN.delayReason,
    scheduledArrival: `${hhmm(TRAIN.scheduledArrivalAt, tz)} local`,
    revisedArrival: `${hhmm(revised, tz)} local`,
    readyAtDealer: `${hhmm(ready, tz)} local`,
    readyAtDealerIso: ready,
    kmToDealerStraightLine: km,
    pickupSlot: slot,
    math: [
      `Train due in ${TRAIN.to} ${hhmm(TRAIN.scheduledArrivalAt, tz)} + ${TRAIN.delayMin / 60} h delay = ${hhmm(revised, tz)}`,
      `${hhmm(revised, tz)} + ${TRAIN.transferMin} min taxi to ${dealer.name} = ${hhmm(ready, tz)} at the dealer`,
      `Train stationary for ${TRAIN.stationaryForMin} min, ${km} km from the dealer in a straight line`,
      ...(order.pickupSlot ? [`Pickup slot ends ${hhmm(order.pickupSlot.end, tz)}: ${Date.parse(ready) > Date.parse(order.pickupSlot.end) ? "missed" : "still reachable"}`] : []),
    ],
    sources: [...order.sources, ...driver.sources, { table: "mock_train_telemetry", id: TRAIN.train }],
  }
}

export type PolicyCheck = {
  dealer: string
  closeTime: string | null
  closesAtIso: string | null
  keyHandoverMethod: KeyHandoverMethod
  afterHoursPickupPossible: boolean
  evidence: string[]
  verdict: string
  sources: SourceRef[]
}

export async function checkDealerPolicy(input: { orderId: string }): Promise<PolicyCheck | null> {
  const dealer = await getDealer(input.orderId)
  if (!dealer) return null
  const closesAtIso = dealer.closeTime ? localTimeToUtc(SCENARIO.day, dealer.closeTime, dealer.timezone) : null
  const afterHours = dealer.keyHandoverMethod === "KEY_BOX"
  const verdict = dealer.keyHandoverMethod === "PERSONAL_ONLY"
    ? `Keys are handed over in person by staff, so nothing can be collected after ${dealer.closeTime ?? "closing"}`
    : dealer.keyHandoverMethod === "KEY_BOX" ? "A key box allows collection after closing"
      : "The record does not say how keys are handed over; ask the site before relying on a late collection"
  return { dealer: dealer.name, closeTime: dealer.closeTime, closesAtIso, keyHandoverMethod: dealer.keyHandoverMethod, afterHoursPickupPossible: afterHours, evidence: dealer.evidence, verdict, sources: dealer.sources }
}

/** The one answer everything else checks against: can the assigned driver still collect today? */
export async function assessDriverInTime(orderId: string): Promise<{ driverInTime: boolean; because: string } | null> {
  const t = await checkTelemetry({ orderId })
  const p = await checkDealerPolicy({ orderId })
  if (!t || !p) return null
  if (p.afterHoursPickupPossible) return { driverInTime: true, because: "a key box allows collection after closing" }
  if (!p.closesAtIso) return { driverInTime: false, because: "closing time not recorded, so a late collection cannot be relied on" }
  const inTime = Date.parse(t.readyAtDealerIso) <= Date.parse(p.closesAtIso)
  return { driverInTime: inTime, because: `ready ${t.readyAtDealer} ${inTime ? "≤" : ">"} closes ${p.closeTime} local, handover ${p.keyHandoverMethod}` }
}

export async function findHotelAndNextJob(input: { driverId: string; nearCity: string }) {
  const driver = await getStrandedDriver(input.driverId)
  if (!driver) return null
  return {
    driver: { id: driver.id, name: driver.name, homeCity: driver.homeCity },
    tonightIn: input.nearCity,
    hotels: hotelsIn(input.nearCity),
    tomorrowsJobs: driverMarketNear(input.nearCity, SCENARIO.nextDay, DEFAULT_MAX_KM, driver.homeCity).slice(0, 4).map((j) => ({
      ...j, pickup: `${hhmm(j.pickupWindow.start, j.pickupWindow.timezone)}–${hhmm(j.pickupWindow.end, j.pickupWindow.timezone)} local on ${j.pickupWindow.start.slice(0, 10)}`,
    })),
    caveat: "Hotels and jobs are mock quotes. Nothing is booked; the driver must accept a job and a person must approve both.",
  }
}

export const ProposalInput = z.object({
  driverInTime: z.boolean().describe("Can the assigned driver still collect the car today? Must match the telemetry and policy checks."),
  reasoningTrace: z.array(z.string()).min(3).describe("Short lines: the ETA math, the closing time and key rule, and the conclusion, with numbers."),
  move1: z.object({
    standbyDriverId: z.string().describe("drv-… from find_standby_driver"),
    note: z.string().describe("What the standby driver is asked to do, and what is not confirmed yet"),
  }),
  move2: z.object({
    hotelId: z.string().describe("hotel id from find_hotel_and_next_job"),
    nextJobId: z.string().describe("mkt-… job id from find_hotel_and_next_job"),
    note: z.string().describe("Why this hotel and this job"),
  }),
  customerNote: z.string().describe("A draft line for the customer about the new pickup timing. A person reviews and sends it."),
})

export type DoubleRecoveryProposal = {
  orderRef: string
  status: "PENDING_APPROVAL"
  driverInTime: boolean
  reasoningTrace: string[]
  move1: { title: string; driverId: string; driverName: string; distanceKm: number; fromCity: string; pickupWhen: string; note: string; caveat: string }
  move2: {
    title: string; strandedDriverId: string; strandedDriverName: string
    hotel: { id: string; name: string; city: string; nightlyEur: number }
    nextJob: { id: string; route: string; pickup: string; feeEur: number }
    note: string; caveat: string
  }
  customerDraft: string
  computedWithoutModel?: boolean
}

export async function buildDoubleRecoveryProposal(input: z.infer<typeof ProposalInput>): Promise<{ ok: true; proposal: DoubleRecoveryProposal } | { ok: false; problems: string[] }> {
  const problems: string[] = []
  const truth = await assessDriverInTime(SCENARIO.orderId)
  const telemetry = await checkTelemetry({ orderId: SCENARIO.orderId })
  const standby = await findStandbyDriver({ orderId: SCENARIO.orderId, maxKm: DEFAULT_MAX_KM, limit: 10 })
  const options = await findHotelAndNextJob({ driverId: SCENARIO.driverId, nearCity: TRAIN.to })
  if (!truth || !telemetry || !standby || !options) return { ok: false, problems: ["The scenario data could not be loaded."] }
  if (input.driverInTime !== truth.driverInTime) problems.push(`driverInTime must be ${truth.driverInTime}: ${truth.because}.`)
  const candidate = standby.candidates.find((c) => c.driverId === input.move1.standbyDriverId)
  if (!candidate) problems.push(`Unknown standby driver ${input.move1.standbyDriverId}; use one returned by find_standby_driver.`)
  const hotel = options.hotels.find((h) => h.id === input.move2.hotelId)
  if (!hotel) problems.push(`Unknown hotel ${input.move2.hotelId}; use one returned by find_hotel_and_next_job.`)
  const next = options.tomorrowsJobs.find((j) => j.id === input.move2.nextJobId)
  if (!next) problems.push(`Unknown job ${input.move2.nextJobId}; use one returned by find_hotel_and_next_job.`)
  if (problems.length || !candidate || !hotel || !next) return { ok: false, problems }
  const tz = standby.order.pickupSlot?.timezone ?? "Europe/Berlin"
  return {
    ok: true,
    proposal: {
      orderRef: telemetry.orderRef,
      status: "PENDING_APPROVAL",
      driverInTime: truth.driverInTime,
      reasoningTrace: input.reasoningTrace,
      move1: {
        title: `Give the pickup to ${candidate.name}`,
        driverId: candidate.driverId, driverName: candidate.name, distanceKm: candidate.distanceKm, fromCity: candidate.location.city,
        pickupWhen: `Today before ${(await checkDealerPolicy({ orderId: SCENARIO.orderId }))?.closeTime ?? "closing"} local at ${standby.order.pickupCity}${standby.order.pickupSlot ? ` (original slot ${hhmm(standby.order.pickupSlot.start, tz)}–${hhmm(standby.order.pickupSlot.end, tz)})` : ""}`,
        note: input.move1.note,
        caveat: standby.caveat,
      },
      move2: {
        title: `Hotel tonight and a new car tomorrow for ${options.driver.name}`,
        strandedDriverId: options.driver.id, strandedDriverName: options.driver.name,
        hotel: { id: hotel.id, name: hotel.name, city: hotel.city, nightlyEur: hotel.nightlyEur },
        nextJob: { id: next.id, route: `${next.pickupCity} → ${next.deliveryCity}`, pickup: next.pickup, feeEur: next.feeEur },
        note: input.move2.note,
        caveat: options.caveat,
      },
      customerDraft: input.customerNote,
    },
  }
}

/** The same proposal without a model, for demos without API access. Labelled as such in the UI. */
export async function buildDoubleRecoveryWithoutModel(): Promise<DoubleRecoveryProposal | null> {
  const t = await checkTelemetry({ orderId: SCENARIO.orderId })
  const p = await checkDealerPolicy({ orderId: SCENARIO.orderId })
  const truth = await assessDriverInTime(SCENARIO.orderId)
  const standby = await findStandbyDriver({ orderId: SCENARIO.orderId, maxKm: DEFAULT_MAX_KM, limit: 3 })
  const options = await findHotelAndNextJob({ driverId: SCENARIO.driverId, nearCity: TRAIN.to })
  if (!t || !p || !truth || !standby?.candidates[0] || !options?.hotels[0] || !options.tomorrowsJobs[0]) return null
  const built = await buildDoubleRecoveryProposal({
    driverInTime: truth.driverInTime,
    reasoningTrace: [...t.math, `${p.dealer} closes ${p.closeTime} local; key handover ${p.keyHandoverMethod}: ${p.verdict}`, `Conclusion: ${truth.because}, so the pickup ${truth.driverInTime ? "can still happen today" : "will fail with this driver"}`],
    move1: { standbyDriverId: standby.candidates[0].driverId, note: "Ask first; offer the pickup only if they confirm they can be at the dealer before closing." },
    move2: { hotelId: options.hotels[0].id, nextJobId: options.tomorrowsJobs[0].id, note: "Nearest hotel to the station, and a job that starts in the same city tomorrow and ends near the driver's home." },
    customerNote: `Collection of ${t.orderRef} moves to a replacement driver today; we confirm the time once they accept.`,
  })
  return built.ok ? { ...built.proposal, computedWithoutModel: true } : null
}

export const doubleRecoveryTools = {
  check_telemetry: tool({
    description: "Read the assigned driver's train telemetry for an order and compute when they can be at the pickup dealer. The train data is mock; the order is real.",
    inputSchema: z.object({ orderId: z.string().describe("ord-… or CD-…") }),
    execute: async ({ orderId }) => (await checkTelemetry({ orderId })) ?? { found: false, message: "No telemetry for this order in the scenario." },
  }),
  check_dealer_policy: tool({
    description: "Check the pickup dealer's closing time on the pickup day and how keys are handed over (PERSONAL_ONLY means no collection after closing), with the record text it is based on.",
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => (await checkDealerPolicy({ orderId })) ?? { found: false, message: "No pickup dealer recorded for this order." },
  }),
  find_standby_driver: tool({
    description: "Find available drivers near the pickup dealer, nearest first, from the dataset. Availability is not confirmed: they must be asked.",
    inputSchema: z.object({ orderId: z.string(), maxKm: z.number().optional() }),
    execute: async ({ orderId, maxKm }) => (await findStandbyDriver({ orderId, maxKm: maxKm ?? DEFAULT_MAX_KM, limit: 3 })) ?? { found: false },
  }),
  find_hotel_and_next_job: tool({
    description: "For the stranded driver: hotels in the city where they end up tonight, and driver-market jobs for tomorrow near there (preferring jobs that end near their home). Mock quotes; nothing is booked.",
    inputSchema: z.object({ driverId: z.string(), nearCity: z.string().describe("Where the driver will be tonight, e.g. the train's destination") }),
    execute: async ({ driverId, nearCity }) => (await findHotelAndNextJob({ driverId, nearCity })) ?? { found: false },
  }),
  generate_reshuffle_proposal: tool({
    description: "Final step. Turn the checks into one Double Recovery proposal for a person to approve: Move 1 gives the pickup to a standby driver, Move 2 books the stranded driver a hotel and tomorrow's job. Ids must come from the other tools. If the result has problems, fix them and call again.",
    inputSchema: ProposalInput,
    execute: async (input) => buildDoubleRecoveryProposal(input),
  }),
}

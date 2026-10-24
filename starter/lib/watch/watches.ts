import "server-only"

import { and, asc, desc, eq, gte, lte } from "drizzle-orm"
import { db } from "@/lib/db"
import { orders, relatedRecords, sites } from "@/lib/schema"
import { emit } from "./bus"
import { DEMO_SCENARIO, type ScenarioCar } from "./mock/scenario"
import { hoursOnDay, nextOpening, type OpeningHours } from "./hours"
import { ROUTES, SITE_PINS, TERMINAL_PINS } from "./mock/world"
import { DEFAULT_PLANNING, planningFromEstimate } from "./planning"
import { cwPositions, cwSlackHistory, cwWatches, type HandoverConfig } from "./schema"
import { evaluateSlack, formatLocal, shouldTrigger, THRESHOLDS, type WatchState } from "./slack"

export type Watch = typeof cwWatches.$inferSelect

// Minimum sim time between two agent starts on the same watch.
const TRIGGER_DEBOUNCE_MIN = 15
const TERMINAL_STATES: WatchState[] = ["MADE", "MISSED"]
const DEADLINE_LABELS: Record<string, string> = { FERRY_CHECKIN: "Check-in", TRAIN: "Departure", PICKUP_SLOT: "Pickup slot", SITE_CLOSE: "Site", DELIVERY_WINDOW: "Delivery window" }

async function snapshotRecord<T = Record<string, unknown>>(collection: string, id: string): Promise<T> {
  const [row] = await db.select().from(relatedRecords).where(and(eq(relatedRecords.collection, collection), eq(relatedRecords.id, id)))
  if (!row) throw new Error(`Snapshot record ${collection}/${id} not found. Run npm run db:seed.`)
  return row.details as T
}

type Reservation = {
  id: string; order_id: string; assignment_id: string; check_in_cutoff_at: string; departure_at: string
  origin_terminal_id: string; origin_terminal: string; terminal_road_estimate_id: string | null
}
type Terminal = { id: string; name: string; timezone: string }
type Assignment = { id: string; driver_id: string | null }

// Builds the watch for a booked ferry: the target is the check-in desk, the deadline its cutoff.
export async function buildFerryWatch(car: ScenarioCar): Promise<Watch> {
  if (!car.reservationId) throw new Error(`Ferry car ${car.orderId} has no reservationId`)
  const reservation = await snapshotRecord<Reservation>("travel_reservations", car.reservationId)
  const terminal = await snapshotRecord<Terminal>("ferry_terminals", reservation.origin_terminal_id)
  const assignment = await snapshotRecord<Assignment>("work_assignments", reservation.assignment_id)
  const estimate = reservation.terminal_road_estimate_id
    ? await snapshotRecord<Parameters<typeof planningFromEstimate>[0]>("terminal_road_estimates", reservation.terminal_road_estimate_id)
    : null
  const pin = TERMINAL_PINS[terminal.id]
  const route = ROUTES[car.routeId]
  if (!pin || !route) throw new Error(`Mock world has no pin or route for ${terminal.id} / ${car.routeId}`)

  const watch: Watch = {
    id: `cw-${reservation.id}`,
    assignmentId: reservation.assignment_id,
    orderId: reservation.order_id,
    driverId: assignment.driver_id,
    targetKind: "FERRY_CHECKIN",
    targetLabel: terminal.name,
    targetRef: { table: "travel_reservations", id: reservation.id },
    deadlineAt: new Date(reservation.check_in_cutoff_at),
    departureAt: new Date(reservation.departure_at),
    targetLat: pin[0],
    targetLng: pin[1],
    targetTimezone: terminal.timezone,
    routePolyline: route.points,
    ...planningFromEstimate(estimate),
    planningRef: reservation.terminal_road_estimate_id ? { table: "terminal_road_estimates", id: reservation.terminal_road_estimate_id } : null,
    reportedDelayMin: 0,
    state: "STALE",
    slackMin: null, etaLowAt: null, etaHighAt: null, remainingKm: null, lastPositionAt: null, lastEvalAt: null,
    explanation: [], madeAt: null, lastTriggerAt: null, handover: null, outlook: null,
  }
  await db.insert(cwWatches).values(watch).onConflictDoUpdate({ target: cwWatches.id, set: watch })
  return watch
}

async function relatedForOrder<T>(collection: string, orderId: string): Promise<(T & { id: string })[]> {
  const rows = await db.select().from(relatedRecords).where(and(eq(relatedRecords.collection, collection), eq(relatedRecords.orderId, orderId)))
  return rows.map((r) => ({ ...(r.details as T), id: r.id }))
}

type Window = { purpose: string; is_selected: boolean; start_at: string; end_at: string }
type Endpoint = { boundary: string; access_instruction?: string | null }
type SiteDetails = { opening_hours?: OpeningHours | null; timezone?: string; advance_notice_minutes?: number }

// Builds the watch for handing the car over at the receiving dealer. The deadline is the end of
// the customer's promised window, or the site's closing time if the site closes first that day.
export async function buildDeliveryWatch(car: ScenarioCar, from: Date): Promise<Watch> {
  const [order] = await db.select().from(orders).where(eq(orders.id, car.orderId))
  if (!order?.deliverySiteId) throw new Error(`${car.orderId} does not deliver to a managed site`)
  const [site] = await db.select().from(sites).where(eq(sites.id, order.deliverySiteId))
  const details = site.details as SiteDetails
  const tz = details.timezone ?? "UTC"
  const hours = details.opening_hours ?? null
  const assignments = await relatedForOrder<{ status: string; driver_id: string | null }>("work_assignments", car.orderId)
  const assignment = assignments.find((a) => a.status === "IN_PROGRESS") ?? assignments[0]
  if (!assignment) throw new Error(`${car.orderId} has no driver assignment`)
  const promise = (await relatedForOrder<Window>("time_windows", car.orderId)).find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.is_selected) ?? null
  const endpoint = (await relatedForOrder<Endpoint>("order_endpoint_details", car.orderId)).find((e) => e.boundary === "DELIVERY") ?? null
  const accessNote = endpoint?.access_instruction ?? null

  const promiseEnd = promise ? new Date(promise.end_at) : null
  const dayOfPromise = promiseEnd ? hoursOnDay(hours, new Date(promiseEnd.getTime() - 60000), tz) : null
  const closeToday = nextOpening(hours, from, tz)?.closesAt ?? null
  let deadlineAt: Date
  let deadlineIs: HandoverConfig["deadlineIs"] = "PROMISE_END"
  if (promiseEnd && dayOfPromise?.kind === "open" && dayOfPromise.closesAt < promiseEnd) { deadlineAt = dayOfPromise.closesAt; deadlineIs = "SITE_CLOSE" }
  else if (promiseEnd) deadlineAt = promiseEnd
  else if (closeToday) { deadlineAt = closeToday; deadlineIs = "SITE_CLOSE" }
  else throw new Error(`${car.orderId} has neither a delivery promise nor known opening hours`)

  const pin = SITE_PINS[site.id]
  const route = ROUTES[car.routeId]
  if (!pin || !route) throw new Error(`Mock world has no pin or route for ${site.id} / ${car.routeId}`)

  const handover: HandoverConfig = {
    siteId: site.id, siteName: site.name, hours: hours as HandoverConfig["hours"], callAheadMin: details.advance_notice_minutes ?? 0,
    afterHoursDrop: accessNote && /no after-hours drop/i.test(accessNote) ? false : undefined,
    accessNote, promiseStartAt: promise?.start_at ?? null, promiseEndAt: promise?.end_at ?? null,
    promiseRef: promise ? { table: "time_windows", id: promise.id } : null, deadlineIs,
  }
  const watch: Watch = {
    id: `cw-${assignment.id}`,
    assignmentId: assignment.id,
    orderId: car.orderId,
    driverId: assignment.driver_id,
    targetKind: "DELIVERY_WINDOW",
    targetLabel: site.name,
    targetRef: promise ? { table: "time_windows", id: promise.id } : { table: "sites", id: site.id },
    deadlineAt,
    departureAt: null,
    targetLat: pin[0],
    targetLng: pin[1],
    targetTimezone: tz,
    routePolyline: route.points,
    ...DEFAULT_PLANNING,
    planningRef: null,
    reportedDelayMin: 0,
    state: "STALE",
    slackMin: null, etaLowAt: null, etaHighAt: null, remainingKm: null, lastPositionAt: null, lastEvalAt: null,
    explanation: [], madeAt: null, lastTriggerAt: null, handover, outlook: null,
  }
  await db.insert(cwWatches).values(watch).onConflictDoUpdate({ target: cwWatches.id, set: watch })
  return watch
}

export async function buildScenarioWatches(): Promise<Watch[]> {
  const out: Watch[] = []
  const from = new Date(DEMO_SCENARIO.startAt)
  for (const car of DEMO_SCENARIO.cars) out.push(car.kind === "delivery" ? await buildDeliveryWatch(car, from) : await buildFerryWatch(car))
  return out
}

// A missed delivery promise is not the end: the dealer can still receive the car until it closes.
// Past the promise, the watch guards the closing time instead and remembers the promise was broken.
export async function rollPromiseToClosing(watch: Watch, now: Date): Promise<Watch> {
  const h = watch.handover
  if (watch.targetKind !== "DELIVERY_WINDOW" || !h || h.deadlineIs !== "PROMISE_END" || now <= watch.deadlineAt || watch.madeAt) return watch
  const today = hoursOnDay(h.hours, now, watch.targetTimezone)
  if (today.kind !== "open" || today.closesAt <= now) return watch
  const handover: HandoverConfig = { ...h, deadlineIs: "SITE_CLOSE", promiseBrokenAt: watch.deadlineAt.toISOString() }
  const rolled = { ...watch, deadlineAt: today.closesAt, handover, targetRef: { table: "sites", id: h.siteId } }
  await db.update(cwWatches).set({ deadlineAt: rolled.deadlineAt, handover, targetRef: rolled.targetRef }).where(eq(cwWatches.id, watch.id))
  return rolled
}

// Words the engine uses for each kind of watch.
function wording(watch: Watch) {
  if (watch.targetKind !== "DELIVERY_WINDOW") return { deadlineLabel: DEADLINE_LABELS[watch.targetKind] ?? "Deadline" }
  return watch.handover?.deadlineIs === "SITE_CLOSE"
    ? { deadlineLabel: watch.targetLabel, deadlineVerb: "closes", deskLabel: "receiving desk", confirmLabel: "handover" }
    : { deadlineLabel: "Delivery promise", deadlineVerb: "ends", deskLabel: "receiving desk", confirmLabel: "handover" }
}

export async function listWatches(): Promise<Watch[]> {
  return db.select().from(cwWatches).orderBy(asc(cwWatches.deadlineAt))
}

export async function watchForAssignment(assignmentId: string): Promise<Watch | null> {
  const [row] = await db.select().from(cwWatches).where(eq(cwWatches.assignmentId, assignmentId))
  return row ?? null
}

// Re-evaluates one watch at sim time `now`. Persists the result, records history,
// emits a live update and, when things got worse, a trigger for the agent.
export async function evaluateWatch(watch: Watch, now: Date): Promise<Watch> {
  if (TERMINAL_STATES.includes(watch.state as WatchState)) return watch
  watch = await rollPromiseToClosing(watch, now)
  const windowStart = new Date(now.getTime() - THRESHOLDS.trendWindowMin * 60000)
  const positions = await db.select().from(cwPositions)
    .where(and(eq(cwPositions.assignmentId, watch.assignmentId), lte(cwPositions.observedAt, now)))
    .orderBy(desc(cwPositions.observedAt)).limit(40)
  positions.reverse()
  const history = await db.select().from(cwSlackHistory)
    .where(and(eq(cwSlackHistory.watchId, watch.id), gte(cwSlackHistory.at, windowStart), lte(cwSlackHistory.at, now)))
    .orderBy(asc(cwSlackHistory.at))

  const result = evaluateSlack({
    now,
    deadlineAt: watch.deadlineAt,
    target: [watch.targetLat, watch.targetLng],
    targetLabel: watch.targetLabel,
    ...wording(watch),
    handover: watch.handover ? { hours: watch.handover.hours, callAheadMin: watch.handover.callAheadMin, afterHoursDrop: watch.handover.afterHoursDrop } : null,
    targetTimezone: watch.targetTimezone,
    route: watch.routePolyline,
    plannedSpeedKmh: watch.plannedSpeedKmh,
    speedSpread: watch.speedSpread,
    reportedDelayMin: watch.reportedDelayMin,
    positions,
    history: history.filter((h) => h.slackMin !== null && h.state !== "STALE").map((h) => ({ at: h.at, slackMin: h.slackMin! })),
    madeAt: watch.madeAt,
  })

  const previous = watch.lastEvalAt ? (watch.state as WatchState) : null
  const minutesSinceTrigger = watch.lastTriggerAt ? (now.getTime() - watch.lastTriggerAt.getTime()) / 60000 : Number.POSITIVE_INFINITY
  // Escalating to a worse state always passes; repeats of the same kind wait out the debounce.
  const trigger = shouldTrigger(previous, result.state) && (minutesSinceTrigger >= TRIGGER_DEBOUNCE_MIN || result.state === "AT_RISK" || result.state === "MISSED")

  if (watch.handover?.promiseBrokenAt) {
    result.explanation.unshift(`The delivery promise ended ${formatLocal(new Date(watch.handover.promiseBrokenAt), watch.targetTimezone)} local without a handover; ${watch.targetLabel} can still receive the car until it closes`)
    // A broken promise stays a risk until the car is handed over, whatever the margin to closing.
    if (result.state === "ON_TRACK" || result.state === "TIGHTENING") result.state = "AT_RISK"
  }

  const updated: Watch = {
    ...watch,
    state: result.state,
    slackMin: result.slackMin,
    etaLowAt: result.etaLowAt,
    etaHighAt: result.etaHighAt,
    remainingKm: result.remainingKm,
    lastPositionAt: positions.at(-1)?.observedAt ?? null,
    lastEvalAt: now,
    explanation: result.explanation,
    outlook: result.handover,
    lastTriggerAt: trigger ? now : watch.lastTriggerAt,
  }
  await db.update(cwWatches).set(updated).where(eq(cwWatches.id, watch.id))

  const [lastHistory] = await db.select().from(cwSlackHistory).where(eq(cwSlackHistory.watchId, watch.id)).orderBy(desc(cwSlackHistory.at)).limit(1)
  if (!lastHistory || now.getTime() - lastHistory.at.getTime() >= 60000 || lastHistory.state !== result.state) {
    await db.insert(cwSlackHistory).values({ watchId: watch.id, at: now, state: result.state, slackMin: result.slackMin, etaLowAt: result.etaLowAt, etaHighAt: result.etaHighAt })
  }

  if (previous !== result.state || watch.slackMin !== result.slackMin) {
    emit({ type: "watch", watchId: watch.id, orderId: watch.orderId, assignmentId: watch.assignmentId, state: result.state, slackMin: result.slackMin, at: now.toISOString() })
  }
  if (trigger) emit({ type: "trigger", watchId: watch.id, orderId: watch.orderId, from: previous, to: result.state, at: now.toISOString() })
  return updated
}

// The connection is made only on a confirmation (driver tap or gate event), never on proximity alone.
export async function confirmMade(watchId: string, at: Date): Promise<void> {
  const [watch] = await db.select().from(cwWatches).where(eq(cwWatches.id, watchId))
  if (!watch || watch.madeAt) return
  await db.update(cwWatches).set({ madeAt: at }).where(eq(cwWatches.id, watchId))
  await evaluateWatch({ ...watch, madeAt: at }, at)
}

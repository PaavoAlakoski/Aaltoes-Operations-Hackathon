import "server-only"

import { db } from "@/lib/db"
import { emit } from "./bus"
import { getClock, setClock } from "./clock"
import { ingestPosition } from "./ingest"
import { DEMO_SCENARIO } from "./mock/scenario"
import { ROUTES } from "./mock/world"
import { sampleCar, type Injection } from "./replay"
import { cwAgentRuns, cwAgentSteps, cwBookings, cwDrafts, cwMessages, cwPositions, cwProposals, cwSlackHistory, cwWatches } from "./schema"
import { buildScenarioWatches, confirmMade, evaluateWatch, listWatches } from "./watches"

// Drives the demo: every real second it advances each scenario car to the current sim time,
// sends its position like a phone would (or queues it while the phone is offline) and
// re-evaluates every watch so a quiet phone turns STALE without any position arriving.

const TICK_MS = 1000
const POST_EVERY_MIN = 1
const AUTO_CHECK_IN_AFTER_MIN = 5

type QueuedPosition = { lat: number; lng: number; speedKmh: number; observedAt: Date }
type CarState = { lastPostedMinute: number; queue: QueuedPosition[]; arrivedAtMinute: number | null }
type RunnerState = {
  interval: ReturnType<typeof setInterval> | null
  busy: boolean
  cars: Map<string, CarState>
  injections: Map<string, Injection[]>
  instance: symbol
}

const INSTANCE = Symbol("runner")
const store = globalThis as unknown as { __cwRunner?: RunnerState }

function state(): RunnerState {
  // A hot reload brings a new module instance; drop the old interval so only current code ticks.
  if (store.__cwRunner && store.__cwRunner.instance !== INSTANCE) {
    if (store.__cwRunner.interval) clearInterval(store.__cwRunner.interval)
    store.__cwRunner = { ...store.__cwRunner, interval: null, busy: false, instance: INSTANCE }
  }
  return store.__cwRunner ??= { interval: null, busy: false, cars: new Map(), injections: new Map(), instance: INSTANCE }
}

const scenarioStart = new Date(DEMO_SCENARIO.startAt)
const minuteOf = (at: Date) => (at.getTime() - scenarioStart.getTime()) / 60000
const atMinute = (minute: number) => new Date(scenarioStart.getTime() + minute * 60000)

export function ensureRunner(): void {
  const s = state()
  if (s.interval) return
  s.interval = setInterval(() => { void tick() }, TICK_MS)
}

async function tick(force = false): Promise<void> {
  const s = state()
  if (s.busy) return
  s.busy = true
  try {
    const clock = await getClock()
    if (!clock || clock.scenarioId !== DEMO_SCENARIO.id) return
    if (clock.speed === 0 && !force) return
    const now = clock.simNow
    const minute = minuteOf(now)
    const watches = await listWatches()
    emit({ type: "tick", simNow: now.toISOString() })

    for (const car of DEMO_SCENARIO.cars) {
      const watch = watches.find((w) => w.orderId === car.orderId)
      if (!watch) continue
      const cs = s.cars.get(car.orderId) ?? { lastPostedMinute: Number.NEGATIVE_INFINITY, queue: [], arrivedAtMinute: null }
      s.cars.set(car.orderId, cs)
      if (watch.madeAt || watch.state === "MISSED") continue

      if (cs.arrivedAtMinute !== null) {
        if (minute - cs.arrivedAtMinute >= AUTO_CHECK_IN_AFTER_MIN) await confirmMade(watch.id, now)
        else await evaluateWatch(watch, now)
        continue
      }
      if (!force && minute - cs.lastPostedMinute < POST_EVERY_MIN) {
        await evaluateWatch(watch, now)
        continue
      }

      const sample = sampleCar(car, ROUTES[car.routeId].points, minute, s.injections.get(car.orderId) ?? [])
      cs.lastPostedMinute = minute
      const reading = { lat: sample.position[0], lng: sample.position[1], speedKmh: Math.round(sample.speedKmh), observedAt: now }
      if (!sample.online) {
        cs.queue.push(reading)
        await evaluateWatch(watch, now)
        continue
      }
      // Back online: the phone uploads what it recorded while quiet, with the original times.
      for (const queued of cs.queue.splice(0)) await ingestPosition({ assignmentId: watch.assignmentId, ...queued, source: "replay" })
      await ingestPosition({ assignmentId: watch.assignmentId, ...reading, source: "replay" })
      if (sample.arrived) cs.arrivedAtMinute = minute
    }
  } catch (error) {
    console.error("[watch runner]", error)
  } finally {
    s.busy = false
  }
}

export async function resetScenario(): Promise<void> {
  const s = state()
  while (s.busy) await new Promise((r) => setTimeout(r, 50))
  s.busy = true
  try {
    await db.transaction(async (tx) => {
      for (const table of [cwAgentSteps, cwAgentRuns, cwProposals, cwMessages, cwDrafts, cwBookings, cwSlackHistory, cwPositions, cwWatches]) await tx.delete(table)
    })
    s.cars.clear()
    s.injections.clear()
    await setClock({ simAt: scenarioStart, speed: 0, scenarioId: DEMO_SCENARIO.id })
    await buildScenarioWatches()
  } finally {
    s.busy = false
  }
  emit({ type: "reset", scenarioId: DEMO_SCENARIO.id })
  // Place every car at its start so the control room is not empty before play.
  await tick(true)
}

export async function play(speed: number = DEMO_SCENARIO.defaultSpeed): Promise<void> {
  ensureRunner()
  await setClock({ speed })
}

export async function pause(): Promise<void> {
  await setClock({ speed: 0 })
}

export async function inject(orderId: string, kind: "jam" | "offline", durationMin = 40, speedKmh = 10): Promise<void> {
  const clock = await getClock()
  if (!clock) throw new Error("Reset the scenario first")
  const minute = minuteOf(clock.simNow)
  const list = state().injections.get(orderId) ?? []
  list.push(kind === "jam" ? { kind, atMin: minute, untilMin: minute + durationMin, speedKmh } : { kind, atMin: minute, untilMin: minute + durationMin })
  state().injections.set(orderId, list)
}

// Where a scenario car is at sim time `at`, and whether its phone is online. For the simulated driver.
export function carNow(orderId: string, at: Date): (ReturnType<typeof sampleCar> & { story: string | null }) | null {
  const car = DEMO_SCENARIO.cars.find((c) => c.orderId === orderId)
  if (!car) return null
  const sample = sampleCar(car, ROUTES[car.routeId].points, minuteOf(at), state().injections.get(orderId) ?? [])
  return { ...sample, story: ("story" in car ? car.story : null) ?? null }
}

export function runnerStatus() {
  const s = state()
  return {
    running: s.interval !== null,
    scenario: { id: DEMO_SCENARIO.id, label: DEMO_SCENARIO.label, startAt: DEMO_SCENARIO.startAt },
    cars: DEMO_SCENARIO.cars.map((c) => ({
      orderId: c.orderId,
      story: "story" in c ? c.story : null,
      queuedPositions: s.cars.get(c.orderId)?.queue.length ?? 0,
      injections: (s.injections.get(c.orderId) ?? []).map((i) => ({ ...i, at: atMinute(i.atMin).toISOString() })),
    })),
  }
}

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { haversineKm, pointAlongRoute, projectOnRoute, routeLengthKm } from "./geo"
import type { LatLng } from "./schema"
import { evaluateSlack, shouldTrigger, slackTrend, type Position, type SlackInput } from "./slack"

// A straight north–south test road of about 111 km (one degree of latitude).
const ROUTE: LatLng[] = [[52.0, 10.0], [52.5, 10.0], [53.0, 10.0]]
const TARGET: LatLng = [53.0, 10.0]
const T0 = new Date("2026-10-21T09:00:00Z")
const at = (min: number) => new Date(T0.getTime() + min * 60000)

// Positions every 2 min moving north at a steady speed, ending at `now`.
function drive(startKm: number, kmh: number, minutes: number, now: Date): Position[] {
  const out: Position[] = []
  for (let m = minutes; m >= 0; m -= 2) {
    const km = startKm + (kmh * (minutes - m)) / 60
    const [lat, lng] = pointAlongRoute(ROUTE, km)
    out.push({ lat, lng, observedAt: new Date(now.getTime() - m * 60000), speedKmh: kmh })
  }
  return out
}

function input(overrides: Partial<SlackInput>): SlackInput {
  return {
    now: T0, deadlineAt: at(180), target: TARGET, targetLabel: "Test terminal", deadlineLabel: "Check-in", targetTimezone: "Europe/Berlin",
    route: ROUTE, plannedSpeedKmh: 90, speedSpread: 0.1, reportedDelayMin: 0, positions: [], history: [],
    ...overrides,
  }
}

describe("geo", () => {
  it("measures the route and projects onto it", () => {
    assert.ok(Math.abs(routeLengthKm(ROUTE) - 111.2) < 0.5)
    const mid = pointAlongRoute(ROUTE, 55.6)
    const p = projectOnRoute(mid, ROUTE)
    assert.ok(Math.abs(p.remainingKm - 55.6) < 0.5)
    assert.ok(p.offRouteKm < 0.1)
  })

  it("reports distance off the route", () => {
    const p = projectOnRoute([52.5, 10.2], ROUTE)
    assert.ok(Math.abs(p.offRouteKm - haversineKm([52.5, 10.2], [52.5, 10.0])) < 0.2)
  })
})

describe("evaluateSlack", () => {
  it("is ON_TRACK with a comfortable margin", () => {
    const r = evaluateSlack(input({ positions: drive(0, 90, 20, T0) }))
    assert.equal(r.state, "ON_TRACK")
    assert.ok(r.slackMin! > 60, `slack ${r.slackMin}`)
    assert.ok(r.etaLowAt! < r.etaHighAt!)
    assert.ok(r.explanation.some((l) => l.includes("km to Test terminal")))
  })

  it("uses the pessimistic end of the range plus buffers", () => {
    const r = evaluateSlack(input({ positions: drive(0, 90, 20, T0) }))
    const fromHigh = (input({}).deadlineAt.getTime() - r.etaHighAt!.getTime()) / 60000
    assert.equal(r.slackMin, Math.round(fromHigh - r.buffersMin))
  })

  it("is AT_RISK when the deadline is close", () => {
    const r = evaluateSlack(input({ deadlineAt: at(70), positions: drive(0, 90, 20, T0) }))
    assert.equal(r.state, "AT_RISK")
  })

  it("is TIGHTENING between the thresholds", () => {
    const r = evaluateSlack(input({ deadlineAt: at(105), positions: drive(0, 90, 20, T0) }))
    assert.equal(r.state, "TIGHTENING", `slack ${r.slackMin}`)
  })

  it("counts a driver-reported delay", () => {
    const calm = evaluateSlack(input({ positions: drive(0, 90, 20, T0) }))
    const delayed = evaluateSlack(input({ positions: drive(0, 90, 20, T0), reportedDelayMin: 30 }))
    assert.equal(calm.slackMin! - delayed.slackMin!, 30)
  })

  it("slows the ETA when the car is crawling", () => {
    const fast = evaluateSlack(input({ positions: drive(0, 90, 20, T0) }))
    const jam = evaluateSlack(input({ positions: drive(0, 10, 20, T0) }))
    assert.ok(jam.slackMin! < fast.slackMin! - 20, `${jam.slackMin} vs ${fast.slackMin}`)
  })

  it("goes STALE, not AT_RISK, when the phone goes quiet", () => {
    const old = drive(0, 90, 20, at(-30))
    const r = evaluateSlack(input({ positions: old }))
    assert.equal(r.state, "STALE")
    assert.ok(r.explanation.some((l) => l.startsWith("Last position 30 min ago")))
  })

  it("is STALE with no positions at all", () => {
    assert.equal(evaluateSlack(input({})).state, "STALE")
  })

  it("is ARRIVED near the target, never MADE without confirmation", () => {
    const r = evaluateSlack(input({ positions: [{ lat: 52.999, lng: 10.0, observedAt: T0 }] }))
    assert.equal(r.state, "ARRIVED")
  })

  it("is MADE once confirmed and MISSED after the deadline", () => {
    assert.equal(evaluateSlack(input({ madeAt: T0 })).state, "MADE")
    assert.equal(evaluateSlack(input({ now: at(181), positions: drive(0, 90, 10, at(181)) })).state, "MISSED")
  })

  it("forecasts trouble from a shrinking margin before the margin is low", () => {
    // History that leads into the current margin, falling 2 min per minute.
    const base = input({ deadlineAt: at(170), positions: drive(0, 90, 20, T0) })
    const now = evaluateSlack(base).slackMin!
    const history = [25, 20, 15, 10, 5].map((ago) => ({ at: at(-ago), slackMin: now + ago * 2 }))
    const r = evaluateSlack({ ...base, history })
    assert.ok(r.trendMinPerHour! < -60, `trend ${r.trendMinPerHour}`)
    assert.ok(r.slackMin! >= 60)
    assert.equal(r.state, "TIGHTENING")
  })
})

describe("evaluateSlack with a receiving site", () => {
  const site = { hours: { mon_fri: "09:00-18:00", sat: null, sun: null }, callAheadMin: 30 }
  // T0 is Wed 21 Oct 11:00 Berlin. The test road takes about 74–90 min plus 20 min buffers.
  it("adds opening-hours lines and the call-ahead time when the site is open on arrival", () => {
    const r = evaluateSlack(input({ deadlineLabel: "Delivery promise", deadlineVerb: "ends", handover: site, positions: drive(0, 90, 20, T0) }))
    assert.equal(r.handover?.verdict, "OPEN_ON_ARRIVAL")
    assert.ok(r.explanation.some((l) => l.startsWith("Test terminal is open 09:00–18:00 local today")))
    assert.ok(r.explanation.some((l) => l.includes("asks for a call 30 min before arrival")))
    assert.ok(r.explanation.some((l) => l.startsWith("Delivery promise ends")))
  })
  it("is AT_RISK when the car would reach a closed site, even with margin to the deadline", () => {
    const shut = { ...site, hours: { mon_fri: "09:00-11:30", sat: null, sun: null } }
    const r = evaluateSlack(input({ handover: shut, positions: drive(0, 90, 20, T0) }))
    assert.ok(r.slackMin! >= 20, `slack ${r.slackMin}`)
    assert.equal(r.handover?.verdict, "AFTER_CLOSING")
    assert.equal(r.state, "AT_RISK")
    assert.ok(r.explanation.some((l) => l.startsWith("Next opening Thursday 09:00")))
  })
  it("flags unknown hours without changing the state", () => {
    const r = evaluateSlack(input({ handover: { hours: {}, callAheadMin: 0 }, positions: drive(0, 90, 20, T0) }))
    assert.equal(r.handover?.verdict, "HOURS_UNKNOWN")
    assert.equal(r.state, "ON_TRACK")
  })
})

describe("slackTrend", () => {
  it("needs three points", () => {
    assert.equal(slackTrend([{ at: T0, slackMin: 10 }], T0), null)
  })
  it("returns minutes per hour", () => {
    const pts = [0, 10, 20].map((m) => ({ at: at(m), slackMin: 100 - m }))
    assert.ok(Math.abs(slackTrend(pts, at(20))! + 60) < 0.01)
  })
})

describe("shouldTrigger", () => {
  it("fires on worsening and on going stale", () => {
    assert.equal(shouldTrigger("ON_TRACK", "TIGHTENING"), true)
    assert.equal(shouldTrigger("TIGHTENING", "AT_RISK"), true)
    assert.equal(shouldTrigger("ON_TRACK", "STALE"), true)
    assert.equal(shouldTrigger(null, "AT_RISK"), true)
  })
  it("does not fire on a soft first reading", () => {
    assert.equal(shouldTrigger(null, "TIGHTENING"), false)
    assert.equal(shouldTrigger(null, "STALE"), false)
  })
  it("stays quiet on improvement or no change", () => {
    assert.equal(shouldTrigger("AT_RISK", "TIGHTENING"), false)
    assert.equal(shouldTrigger("TIGHTENING", "TIGHTENING"), false)
    assert.equal(shouldTrigger("STALE", "ON_TRACK"), false)
  })
})

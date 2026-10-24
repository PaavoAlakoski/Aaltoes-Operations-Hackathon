import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { handoverOutlook, hoursOnDay, localToUtc, nextOpening, type OpeningHours } from "./hours"

// Kervandorio Tampere in the dataset (site with a 30 min call-ahead).
const TAMPERE: OpeningHours = { mon_fri: "09:00-18:00", sat: "08:00-12:00", sun: null }
const HEL = "Europe/Helsinki"
const BER = "Europe/Berlin"
// 21 Oct 2026 is a Wednesday; Finland is UTC+3 until 25 Oct, then UTC+2.
const wed = (h: number, m = 0) => localToUtc(2026, 10, 21, h, m, HEL)

describe("localToUtc", () => {
  it("handles summer time and the switch on 25 October", () => {
    assert.equal(localToUtc(2026, 10, 21, 18, 0, HEL).toISOString(), "2026-10-21T15:00:00.000Z")
    assert.equal(localToUtc(2026, 10, 26, 9, 0, HEL).toISOString(), "2026-10-26T07:00:00.000Z")
    assert.equal(localToUtc(2026, 10, 21, 17, 0, BER).toISOString(), "2026-10-21T15:00:00.000Z")
  })
})

describe("hoursOnDay", () => {
  it("reads weekday, Saturday and closed Sunday", () => {
    const w = hoursOnDay(TAMPERE, wed(12), HEL)
    assert.equal(w.kind, "open")
    assert.equal(w.kind === "open" && w.closesAt.toISOString(), "2026-10-21T15:00:00.000Z")
    const sat = hoursOnDay(TAMPERE, localToUtc(2026, 10, 24, 10, 0, HEL), HEL)
    assert.equal(sat.kind === "open" && sat.closesAt.toISOString(), "2026-10-24T09:00:00.000Z")
    assert.equal(hoursOnDay(TAMPERE, localToUtc(2026, 10, 25, 10, 0, HEL), HEL).kind, "closed")
  })
  it("treats missing hours as unknown, not closed", () => {
    assert.equal(hoursOnDay({}, wed(12), HEL).kind, "unknown")
    assert.equal(hoursOnDay(null, wed(12), HEL).kind, "unknown")
    assert.equal(hoursOnDay({ mon_fri: "09:00-17:00" }, localToUtc(2026, 10, 24, 10, 0, HEL), HEL).kind, "unknown")
  })
})

describe("nextOpening", () => {
  it("skips a closed Sunday", () => {
    const after = localToUtc(2026, 10, 24, 13, 0, HEL) // Saturday after closing
    assert.equal(nextOpening(TAMPERE, after, HEL)?.opensAt.toISOString(), "2026-10-26T07:00:00.000Z") // Monday 09:00, now UTC+2
  })
})

describe("handoverOutlook", () => {
  const base = { siteName: "Kervandorio Tampere", hours: TAMPERE, timezone: HEL }

  it("open on arrival, with margin to closing and the call-ahead time", () => {
    const o = handoverOutlook({ ...base, arriveLow: wed(15, 10), arriveHigh: wed(15, 40), callAheadMin: 30 })
    assert.equal(o.verdict, "OPEN_ON_ARRIVAL")
    assert.equal(o.closeMarginMin, 140)
    assert.equal(o.callAheadAt?.toISOString(), wed(14, 40).toISOString())
    assert.ok(o.lines.some((l) => l.includes("call 30 min before arrival, about 14:40")))
  })

  it("leaves out a call-ahead time that has already passed", () => {
    const o = handoverOutlook({ ...base, arriveLow: wed(15, 10), arriveHigh: wed(15, 40), callAheadMin: 30, now: wed(14, 50) })
    assert.ok(!o.lines.some((l) => l.includes("asks for a call")))
  })

  it("after closing on a weekday points to the next morning", () => {
    const o = handoverOutlook({ ...base, arriveLow: wed(18, 5), arriveHigh: wed(18, 30), afterHoursDrop: false })
    assert.equal(o.verdict, "AFTER_CLOSING")
    assert.equal(o.nextOpenAt?.toISOString(), localToUtc(2026, 10, 22, 9, 0, HEL).toISOString())
    assert.match(o.lines[0], /after Kervandorio Tampere closes at 18:00 local\. No after-hours drop\./)
    assert.match(o.lines[1], /Next opening Thursday 09:00/)
  })

  it("Saturday afternoon is closed early; Sunday rolls to Monday", () => {
    const sat = handoverOutlook({ ...base, arriveLow: localToUtc(2026, 10, 24, 12, 30, HEL), arriveHigh: localToUtc(2026, 10, 24, 13, 0, HEL) })
    assert.equal(sat.verdict, "AFTER_CLOSING")
    const sun = handoverOutlook({ ...base, arriveLow: localToUtc(2026, 10, 25, 10, 0, HEL), arriveHigh: localToUtc(2026, 10, 25, 11, 0, HEL) })
    assert.equal(sun.verdict, "CLOSED_THAT_DAY")
    assert.match(sun.lines[1], /Next opening Monday 09:00/)
  })

  it("early arrival waits for opening", () => {
    const o = handoverOutlook({ ...base, arriveLow: wed(8, 15), arriveHigh: wed(9, 20) })
    assert.equal(o.verdict, "BEFORE_OPENING")
    assert.equal(o.waitMin, 45)
  })

  it("unknown hours are flagged, never guessed", () => {
    const o = handoverOutlook({ ...base, hours: {}, arriveLow: wed(20), arriveHigh: wed(21) })
    assert.equal(o.verdict, "HOURS_UNKNOWN")
    assert.equal(o.closesAt, null)
  })
})

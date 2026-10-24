import { haversineKm, remainingKm } from "./geo"
import { handoverOutlook, type HandoverOutlook, type OpeningHours } from "./hours"
import type { LatLng } from "./schema"

// The slack engine. Pure and deterministic: no database, no clock, no model.
// It runs on every position and on every sweep; the agent only starts on a worsening state.

export type WatchState = "ON_TRACK" | "TIGHTENING" | "AT_RISK" | "STALE" | "ARRIVED" | "MADE" | "MISSED"

export const THRESHOLDS = {
  comfortableMin: 60,
  atRiskMin: 20,
  staleAfterMin: 20,
  arrivedWithinKm: 0.3,
  trendWindowMin: 30,
  forecastHorizonMin: 60,
  handlingMin: 10,
  checkInWalkMin: 10,
  breakEveryDriveMin: 120,
  breakMin: 15,
  observedWeight: 0.4,
  minObservedSpeedKmh: 3,
  maxObservedSpeedKmh: 130,
} as const

export type Position = { lat: number; lng: number; observedAt: Date; speedKmh?: number | null }
export type SlackPoint = { at: Date; slackMin: number }

export type SlackInput = {
  now: Date
  deadlineAt: Date
  target: LatLng
  // Where the car is going, e.g. "West Baltic Vehicle Terminal", and what closes there, e.g. "Check-in".
  targetLabel: string
  deadlineLabel: string
  targetTimezone: string
  route: LatLng[]
  plannedSpeedKmh: number
  // Half-width of the planning range as a fraction of the middle, e.g. 0.135 for 480–630 min.
  speedSpread: number
  reportedDelayMin: number
  // Positions ordered oldest → newest. Only the recent ones matter.
  positions: Position[]
  history: SlackPoint[]
  madeAt?: Date | null
  // Wording for other targets than a check-in, e.g. "ends" / "receiving desk" / "handover".
  deadlineVerb?: string
  deskLabel?: string
  confirmLabel?: string
  // A receiving site: its opening hours decide whether the car can be handed over on arrival.
  handover?: { hours: OpeningHours | null; callAheadMin: number; afterHoursDrop?: boolean } | null
}

export type SlackResult = {
  state: WatchState
  slackMin: number | null
  etaLowAt: Date | null
  etaMidAt: Date | null
  etaHighAt: Date | null
  remainingKm: number | null
  observedSpeedKmh: number | null
  blendedSpeedKmh: number | null
  buffersMin: number
  minutesSincePosition: number | null
  trendMinPerHour: number | null
  minutesUntilAtRisk: number | null
  handover: HandoverOutlook | null
  explanation: string[]
}

const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60000
const addMinutes = (d: Date, min: number) => new Date(d.getTime() + min * 60000)

export function formatLocal(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(d)
}

export function observedSpeed(positions: Position[], now: Date): number | null {
  const recent = positions.filter((p) => minutesBetween(p.observedAt, now) <= THRESHOLDS.trendWindowMin)
  if (recent.length < 2) return null
  let km = 0
  for (let i = 1; i < recent.length; i++) km += haversineKm([recent[i - 1].lat, recent[i - 1].lng], [recent[i].lat, recent[i].lng])
  const hours = minutesBetween(recent[0].observedAt, recent[recent.length - 1].observedAt) / 60
  if (hours <= 0) return null
  return Math.min(THRESHOLDS.maxObservedSpeedKmh, km / hours)
}

// Least-squares slope of slack over the trend window, in minutes of slack per hour.
export function slackTrend(history: SlackPoint[], now: Date): number | null {
  const pts = history.filter((p) => minutesBetween(p.at, now) <= THRESHOLDS.trendWindowMin)
  if (pts.length < 3) return null
  const xs = pts.map((p) => minutesBetween(pts[0].at, p.at) / 60)
  const ys = pts.map((p) => p.slackMin)
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length
  const my = ys.reduce((s, y) => s + y, 0) / ys.length
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  if (den === 0) return null
  return num / den
}

export function buffersFor(driveMin: number, reportedDelayMin: number, deskLabel = "check-in desk"): { total: number; lines: string[] } {
  const breaks = Math.floor(driveMin / THRESHOLDS.breakEveryDriveMin) * THRESHOLDS.breakMin
  const total = breaks + THRESHOLDS.handlingMin + THRESHOLDS.checkInWalkMin + reportedDelayMin
  const parts = [`${THRESHOLDS.handlingMin} min car handling`, `${THRESHOLDS.checkInWalkMin} min to the ${deskLabel}`]
  if (breaks) parts.unshift(`${breaks} min breaks`)
  if (reportedDelayMin) parts.push(`${reportedDelayMin} min delay the driver reported`)
  return { total, lines: [`+${total} min for ${parts.join(", ")}`] }
}

export function evaluateSlack(input: SlackInput): SlackResult {
  const { now, deadlineAt, targetTimezone: tz } = input
  const base: Omit<SlackResult, "state" | "explanation"> = {
    slackMin: null, etaLowAt: null, etaMidAt: null, etaHighAt: null, remainingKm: null,
    observedSpeedKmh: null, blendedSpeedKmh: null, buffersMin: 0, minutesSincePosition: null,
    trendMinPerHour: null, minutesUntilAtRisk: null, handover: null,
  }
  const closes = `${input.deadlineLabel} ${input.deadlineVerb ?? "closes"} ${formatLocal(deadlineAt, tz)} local time`

  if (input.madeAt) {
    return { ...base, state: "MADE", explanation: [`Made the connection at ${formatLocal(input.madeAt, tz)}`] }
  }

  const last = input.positions.at(-1)
  if (!last) {
    const state: WatchState = now > deadlineAt ? "MISSED" : "STALE"
    return { ...base, state, explanation: ["No position from the driver app yet", closes] }
  }

  const here: LatLng = [last.lat, last.lng]
  const sinceMin = minutesBetween(last.observedAt, now)
  const remaining = remainingKm(here, input.route, input.target)
  const observed = observedSpeed(input.positions, now)
  // A standing car is not modelled as "never arrives": time passing with no progress already eats the margin.
  const blended = observed === null
    ? input.plannedSpeedKmh
    : (1 - THRESHOLDS.observedWeight) * input.plannedSpeedKmh + THRESHOLDS.observedWeight * Math.max(observed, THRESHOLDS.minObservedSpeedKmh)

  // Times are measured from the position, not from now, so a stale point does not look fresher than it is.
  const driveMin = (remaining.km / blended) * 60
  const etaMid = addMinutes(last.observedAt, driveMin)
  const etaLow = addMinutes(last.observedAt, driveMin * (1 - input.speedSpread))
  const etaHigh = addMinutes(last.observedAt, driveMin * (1 + input.speedSpread))
  const buffers = buffersFor(driveMin, input.reportedDelayMin, input.deskLabel)
  const slack = Math.round(minutesBetween(addMinutes(etaHigh, buffers.total), deadlineAt))
  const trend = slackTrend([...input.history, { at: now, slackMin: slack }], now)
  const untilAtRisk = trend !== null && trend < 0 && slack > THRESHOLDS.atRiskMin
    ? Math.round(((slack - THRESHOLDS.atRiskMin) / -trend) * 60)
    : null

  const lines: string[] = []
  lines.push(`${Math.round(remaining.km)} km to ${input.targetLabel}${remaining.onRoute ? " along the planned route" : " (off the planned route, straight-line estimate)"}`)
  if (observed === null) lines.push(`Using the planned ${Math.round(input.plannedSpeedKmh)} km/h; not enough recent positions for a live speed`)
  else lines.push(`About ${Math.round(observed)} km/h over the last ${THRESHOLDS.trendWindowMin} min (planned ${Math.round(input.plannedSpeedKmh)} km/h)`)
  lines.push(`Arrives ${formatLocal(etaLow, tz)}–${formatLocal(etaHigh, tz)} local time`)
  lines.push(...buffers.lines)
  lines.push(closes)
  if (sinceMin >= 1) lines.push(`Last position ${Math.round(sinceMin)} min ago`)
  if (trend !== null && Math.abs(trend) >= 5) {
    lines.push(trend < 0 ? `Margin shrinking about ${Math.round(-trend)} min per hour` : `Margin growing about ${Math.round(trend)} min per hour`)
  }
  // Opening hours are judged on when the car is ready to hand over, buffers included.
  const outlook = input.handover
    ? handoverOutlook({
      siteName: input.targetLabel, hours: input.handover.hours, timezone: tz,
      arriveLow: addMinutes(etaLow, buffers.total), arriveHigh: addMinutes(etaHigh, buffers.total),
      callAheadMin: input.handover.callAheadMin, afterHoursDrop: input.handover.afterHoursDrop, now,
    })
    : null
  if (outlook) lines.push(...outlook.lines)
  const closedOnArrival = outlook?.verdict === "AFTER_CLOSING" || outlook?.verdict === "CLOSED_THAT_DAY"

  const result = {
    ...base,
    slackMin: slack, etaLowAt: etaLow, etaMidAt: etaMid, etaHighAt: etaHigh, remainingKm: remaining.km,
    observedSpeedKmh: observed, blendedSpeedKmh: blended, buffersMin: buffers.total,
    minutesSincePosition: sinceMin, trendMinPerHour: trend, minutesUntilAtRisk: untilAtRisk, handover: outlook,
  }

  if (now > deadlineAt) return { ...result, state: "MISSED", explanation: lines }
  if (haversineKm(here, input.target) <= THRESHOLDS.arrivedWithinKm) {
    return { ...result, state: "ARRIVED", explanation: [`At ${input.targetLabel}; ${input.confirmLabel ?? input.deadlineLabel.toLowerCase()} not confirmed yet`, closes] }
  }
  if (sinceMin > THRESHOLDS.staleAfterMin) return { ...result, state: "STALE", explanation: lines }
  // Arriving to a closed site means the car waits for the next opening, whatever the margin says.
  if (slack < THRESHOLDS.atRiskMin || closedOnArrival) return { ...result, state: "AT_RISK", explanation: lines }
  const forecastTight = untilAtRisk !== null && untilAtRisk <= THRESHOLDS.forecastHorizonMin
  if (slack < THRESHOLDS.comfortableMin || forecastTight) {
    if (forecastTight) lines.push(`At this pace the margin drops under ${THRESHOLDS.atRiskMin} min in about ${untilAtRisk} min`)
    return { ...result, state: "TIGHTENING", explanation: lines }
  }
  return { ...result, state: "ON_TRACK", explanation: lines }
}

const SEVERITY: Record<WatchState, number> = { MADE: 0, ARRIVED: 0, ON_TRACK: 0, TIGHTENING: 1, STALE: 1, AT_RISK: 2, MISSED: 3 }

// The agent starts when things get worse, or when the signal goes quiet. Never on improvement.
// A first reading has no live speed yet, so only a clear risk is worth acting on.
export function shouldTrigger(previous: WatchState | null, next: WatchState): boolean {
  if (previous === null) return SEVERITY[next] >= SEVERITY.AT_RISK
  if (previous === next) return false
  if (next === "STALE") return true
  return SEVERITY[next] > SEVERITY[previous ?? "ON_TRACK"]
}

export function severity(state: WatchState): number {
  return SEVERITY[state]
}

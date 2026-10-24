// Opening hours of a receiving site, and what they mean for a car's arrival. Pure: no clock, no I/O.
//
// Dataset shape (sites.opening_hours): { mon_fri: "08:30-19:00", sat: "09:00-13:00" | null, sun: null }.
// A missing key or an empty object means the hours are not recorded, which is not the same as closed.
// null means closed that day.

export type OpeningHours = { mon_fri?: string | null; sat?: string | null; sun?: string | null }
export type DayHours = { kind: "open"; opensAt: Date; closesAt: Date } | { kind: "closed" } | { kind: "unknown" }

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export function localParts(d: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return { year: +get("year"), month: +get("month"), day: +get("day"), hour: +get("hour"), minute: +get("minute"), weekday: WEEKDAYS.indexOf(get("weekday")) }
}

// Minutes the zone is ahead of UTC at instant d.
function offsetMin(d: Date, timezone: string): number {
  const p = localParts(d, timezone)
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(d.getTime() / 60000) * 60000) / 60000
}

// The instant when the wall clock in `timezone` shows the given local date and time.
export function localToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = offsetMin(new Date(guess), timezone)
  const t = guess - first * 60000
  const second = offsetMin(new Date(t), timezone)
  return new Date(second === first ? t : guess - second * 60000)
}

export function hoursKnown(hours: OpeningHours | null | undefined): hours is OpeningHours {
  return Boolean(hours) && ["mon_fri", "sat", "sun"].some((k) => k in hours!)
}

function rangeFor(hours: OpeningHours, weekday: number): string | null | undefined {
  if (weekday === 0) return hours.sun
  if (weekday === 6) return hours.sat
  return hours.mon_fri
}

// Opening on the local calendar day that contains instant `on`.
export function hoursOnDay(hours: OpeningHours | null | undefined, on: Date, timezone: string): DayHours {
  if (!hoursKnown(hours)) return { kind: "unknown" }
  const p = localParts(on, timezone)
  const range = rangeFor(hours, p.weekday)
  if (range === undefined) return { kind: "unknown" }
  if (range === null || range.trim() === "") return { kind: "closed" }
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim())
  if (!m) return { kind: "unknown" }
  return {
    kind: "open",
    opensAt: localToUtc(p.year, p.month, p.day, +m[1], +m[2], timezone),
    closesAt: localToUtc(p.year, p.month, p.day, +m[3], +m[4], timezone),
  }
}

// The first opening that is still open at or after `from`, within a week.
export function nextOpening(hours: OpeningHours | null | undefined, from: Date, timezone: string): { opensAt: Date; closesAt: Date } | null {
  if (!hoursKnown(hours)) return null
  for (let i = 0; i < 8; i++) {
    // Noon on each following local day avoids landing on a DST edge.
    const p = localParts(new Date(from.getTime() + i * 86400000), timezone)
    const day = hoursOnDay(hours, localToUtc(p.year, p.month, p.day, 12, 0, timezone), timezone)
    if (day.kind === "open" && day.closesAt > from) return { opensAt: day.opensAt, closesAt: day.closesAt }
  }
  return null
}

export type HandoverVerdict = "OPEN_ON_ARRIVAL" | "BEFORE_OPENING" | "AFTER_CLOSING" | "CLOSED_THAT_DAY" | "HOURS_UNKNOWN"

export type HandoverOutlook = {
  verdict: HandoverVerdict
  hoursToday: string
  closesAt: Date | null
  closeMarginMin: number | null
  nextOpenAt: Date | null
  waitMin: number | null
  callAheadAt: Date | null
  lines: string[]
}

const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(d)
const dayName = (d: Date, tz: string) => DAY_NAMES[localParts(d, tz).weekday]
const duration = (min: number) => (min >= 90 ? `${Math.round(min / 60)} h` : `${Math.round(min)} min`)

export function describeDay(day: DayHours, tz: string): string {
  if (day.kind === "unknown") return "hours not recorded"
  if (day.kind === "closed") return "closed"
  return `${hhmm(day.opensAt, tz)}–${hhmm(day.closesAt, tz)}`
}

// What the site's hours mean for an arrival between `arriveLow` and `arriveHigh` (handover ready).
export function handoverOutlook(input: {
  siteName: string
  hours: OpeningHours | null | undefined
  timezone: string
  arriveLow: Date
  arriveHigh: Date
  callAheadMin?: number
  afterHoursDrop?: boolean
  // When given, a call-ahead time already in the past is left out: it is no longer something to do.
  now?: Date
}): HandoverOutlook {
  const { siteName, timezone: tz, arriveHigh } = input
  const callAheadAt = input.callAheadMin ? new Date(input.arriveLow.getTime() - input.callAheadMin * 60000) : null
  const callLine = input.callAheadMin && callAheadAt && (!input.now || callAheadAt > input.now) ? [`${siteName} asks for a call ${input.callAheadMin} min before arrival, about ${hhmm(callAheadAt, tz)} local`] : []
  const day = hoursOnDay(input.hours, arriveHigh, tz)
  const base = { hoursToday: describeDay(day, tz), callAheadAt }

  if (day.kind === "unknown") {
    return {
      ...base, verdict: "HOURS_UNKNOWN", closesAt: null, closeMarginMin: null, nextOpenAt: null, waitMin: null,
      lines: [`Opening hours for ${siteName} are not recorded; do not assume someone can receive the car late`, ...callLine],
    }
  }
  const noDrop = input.afterHoursDrop === false ? " No after-hours drop." : ""
  if (day.kind === "closed" || arriveHigh >= day.closesAt) {
    const next = nextOpening(input.hours, arriveHigh, tz)
    const waitMin = next ? Math.max(0, (next.opensAt.getTime() - arriveHigh.getTime()) / 60000) : null
    const why = day.kind === "closed"
      ? `${siteName} is closed on ${dayName(arriveHigh, tz)}s`
      : `Arrives up to ${duration((arriveHigh.getTime() - day.closesAt.getTime()) / 60000)} after ${siteName} closes at ${hhmm(day.closesAt, tz)} local`
    return {
      ...base, verdict: day.kind === "closed" ? "CLOSED_THAT_DAY" : "AFTER_CLOSING",
      closesAt: day.kind === "open" ? day.closesAt : null,
      closeMarginMin: day.kind === "open" ? Math.round((day.closesAt.getTime() - arriveHigh.getTime()) / 60000) : null,
      nextOpenAt: next?.opensAt ?? null, waitMin,
      lines: [
        `${why}.${noDrop}`,
        next ? `Next opening ${dayName(next.opensAt, tz)} ${hhmm(next.opensAt, tz)} local, about ${duration(waitMin!)} later` : "No opening found in the next week",
        ...callLine,
      ],
    }
  }
  const closeMarginMin = Math.round((day.closesAt.getTime() - arriveHigh.getTime()) / 60000)
  if (input.arriveLow < day.opensAt) {
    const waitMin = Math.round((day.opensAt.getTime() - input.arriveLow.getTime()) / 60000)
    return {
      ...base, verdict: "BEFORE_OPENING", closesAt: day.closesAt, closeMarginMin, nextOpenAt: day.opensAt, waitMin,
      lines: [`May arrive before ${siteName} opens at ${hhmm(day.opensAt, tz)} local and wait up to ${duration(waitMin)}`, ...callLine],
    }
  }
  return {
    ...base, verdict: "OPEN_ON_ARRIVAL", closesAt: day.closesAt, closeMarginMin, nextOpenAt: null, waitMin: null,
    lines: [`${siteName} is open ${describeDay(day, tz)} local today; arrival leaves ${duration(closeMarginMin)} before closing`, ...callLine],
  }
}

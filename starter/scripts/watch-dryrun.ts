// Dry run of the demo morning without a database or a model: replays every scenario car,
// feeds positions to the slack engine and prints each state change. Use it to tune the scenario.
//   npx tsx scripts/watch-dryrun.ts
import { readFileSync } from "node:fs"
import path from "node:path"
import { hoursOnDay, type OpeningHours } from "../lib/watch/hours"
import { DEMO_SCENARIO, type ScenarioCar } from "../lib/watch/mock/scenario"
import { ROUTES, SITE_PINS, TERMINAL_PINS } from "../lib/watch/mock/world"
import { DEFAULT_PLANNING, planningFromEstimate } from "../lib/watch/planning"
import { sampleCar } from "../lib/watch/replay"
import { evaluateSlack, formatLocal, shouldTrigger, type Position, type SlackInput, type SlackPoint, type WatchState } from "../lib/watch/slack"

const dir = process.env.DATASET_DIR ?? path.join(__dirname, "../../dataset/data")
const rows = (name: string) => readFileSync(path.join(dir, `${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const reservations = new Map(rows("travel_reservations").map((r) => [r.id, r]))
const estimates = new Map(rows("terminal_road_estimates").map((r) => [r.id, r]))
const terminals = new Map(rows("ferry_terminals").map((r) => [r.id, r]))
const orders = new Map(rows("orders").map((r) => [r.id, r]))
const sites = new Map(rows("sites").map((r) => [r.id, r]))
const windows = rows("time_windows")

const start = new Date(DEMO_SCENARIO.startAt)
const STEP = 2

// The same target the app builds, read straight from the JSONL files.
function target(car: ScenarioCar): { title: string; fixed: Omit<SlackInput, "now" | "positions" | "history" | "route" | "reportedDelayMin"> } {
  if (car.kind === "ferry") {
    const res = reservations.get(car.reservationId!)
    const terminal = terminals.get(res.origin_terminal_id)
    const deadlineAt = new Date(res.check_in_cutoff_at)
    const planning = planningFromEstimate(estimates.get(res.terminal_road_estimate_id))
    return {
      title: `${terminal.name}, check-in closes ${formatLocal(deadlineAt, terminal.timezone)}`,
      fixed: { deadlineAt, target: TERMINAL_PINS[res.origin_terminal_id], targetLabel: terminal.name, deadlineLabel: "Check-in", targetTimezone: terminal.timezone, ...planning },
    }
  }
  const site = sites.get(orders.get(car.orderId).delivery_site_id)
  const hours = site.opening_hours as OpeningHours
  const promise = windows.find((w) => w.order_id === car.orderId && w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.is_selected)
  const promiseEnd = new Date(promise.end_at)
  const day = hoursOnDay(hours, new Date(promiseEnd.getTime() - 60000), site.timezone)
  const siteFirst = day.kind === "open" && day.closesAt < promiseEnd
  const deadlineAt = siteFirst && day.kind === "open" ? day.closesAt : promiseEnd
  return {
    title: `${site.name}, promise ends ${formatLocal(promiseEnd, site.timezone)}, open ${day.kind === "open" ? `${formatLocal(day.opensAt, site.timezone)}–${formatLocal(day.closesAt, site.timezone)}` : day.kind}`,
    fixed: {
      deadlineAt, target: SITE_PINS[site.id], targetLabel: site.name, targetTimezone: site.timezone, ...DEFAULT_PLANNING,
      deadlineLabel: siteFirst ? site.name : "Delivery promise", deadlineVerb: siteFirst ? "closes" : "ends", deskLabel: "receiving desk", confirmLabel: "handover",
      handover: { hours, callAheadMin: site.advance_notice_minutes ?? 0 },
    },
  }
}

for (const car of DEMO_SCENARIO.cars) {
  const { title, fixed } = target(car)
  const route = ROUTES[car.routeId].points
  const tz = fixed.targetTimezone
  const positions: Position[] = []
  const history: SlackPoint[] = []
  let previous: WatchState | null = null
  let lastVerdict: string | null = null
  let promiseBroken = false
  console.log(`\n${car.orderId} → ${title} (${fixed.plannedSpeedKmh.toFixed(0)} km/h ±${(fixed.speedSpread * 100).toFixed(0)}%)`)
  for (let minute = 0; ; minute += STEP) {
    const now = new Date(start.getTime() + minute * 60000)
    // Same rule as the app: past the promise, a delivery watch guards the site's closing time.
    if (fixed.handover && fixed.deadlineVerb === "ends" && now > fixed.deadlineAt) {
      const today = hoursOnDay(fixed.handover.hours, now, tz)
      if (today.kind === "open" && today.closesAt > now) {
        console.log(`  ${formatLocal(now, tz)}  promise ended without a handover; now guarding closing at ${formatLocal(today.closesAt, tz)}`)
        Object.assign(fixed, { deadlineAt: today.closesAt, deadlineLabel: fixed.targetLabel, deadlineVerb: "closes" })
        promiseBroken = true
      }
    }
    const s = sampleCar(car, route, minute)
    if (s.online) positions.push({ lat: s.position[0], lng: s.position[1], observedAt: now, speedKmh: s.speedKmh })
    const r = evaluateSlack({ ...fixed, now, route, reportedDelayMin: 0, positions: positions.slice(-30), history })
    if (promiseBroken && (r.state === "ON_TRACK" || r.state === "TIGHTENING")) r.state = "AT_RISK"
    if (r.slackMin !== null && r.state !== "STALE") history.push({ at: now, slackMin: r.slackMin })
    const verdict = r.handover?.verdict ?? null
    if (r.state !== previous || verdict !== lastVerdict) {
      const flag = shouldTrigger(previous, r.state) ? "  ← agent" : ""
      const site = verdict ? `  [${verdict.toLowerCase().replaceAll("_", " ")}${r.handover?.closeMarginMin != null ? `, ${r.handover.closeMarginMin} min before closing` : ""}]` : ""
      console.log(`  ${formatLocal(now, tz)}  ${r.state.padEnd(10)} slack ${String(r.slackMin ?? "-").padStart(4)} min  ${s.kmToGo.toFixed(0).padStart(4)} km to go${s.zone ? `  (${s.zone})` : ""}${site}${flag}`)
      previous = r.state
      lastVerdict = verdict
    }
    if (["ARRIVED", "MISSED"].includes(r.state) || minute > 600) break
  }
}

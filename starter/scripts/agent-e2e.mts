// End-to-end check of the agent against the real database, with a scripted model (no API cost).
// Trigger → tools on real data → proposal → a person approves → executor rechecks and applies →
// the run wakes with the decision → tells the driver → closes. Then the reject path.
//   npm run test:e2e        (needs Postgres from compose.yaml and a seeded snapshot)
import "dotenv/config"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import path from "node:path"
import { eq } from "drizzle-orm"

process.env.AGENT_MODE = "live" // enabled, but the model is the script below
process.env.DRIVER_MODE = "canned"
// Scripted runs are not real agent traces; keep them out of the repo's traces/ folder.
process.env.TRACE_DIR ??= path.join((await import("node:os")).tmpdir(), "cw-e2e-traces")

const { db } = await import("../lib/db")
const { resetScenario } = await import("../lib/watch/runner")
const { cwAgentRuns, cwBookings, cwDrafts, cwMessages, cwProposals, cwWatches } = await import("../lib/watch/schema")
const { deliver, ensureAgentService, setModelForTesting } = await import("../lib/agent/service")
const { decide } = await import("../lib/agent/executor")
const { TRACE_DIR } = await import("../lib/agent/store")
type ModelClient = import("../lib/agent/types").ModelClient
type ContentBlock = import("../lib/agent/types").ContentBlock

const ORDER = "ord-00603"
let n = 0
const use = (name: string, input: unknown) => ({ type: "tool_use", id: `tu_${++n}`, name, input }) as unknown as ContentBlock
const say = (text: string) => ({ type: "text", text, citations: null }) as unknown as ContentBlock

function scripted(turns: ((sent: string) => ContentBlock[])[]): ModelClient & { log: string[] } {
  const log: string[] = []
  return {
    log,
    async create({ messages }) {
      const last = JSON.stringify(messages.at(-1))
      log.push(last)
      const turn = turns.shift()
      if (!turn) throw new Error(`Script ran out; last message: ${last.slice(0, 300)}`)
      const content = turn(last)
      return { content, stopReason: "tool_use", inputTokens: 100, outputTokens: 20, raw: null }
    },
  }
}

async function settle(orderId: string, statuses: string[], timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const [run] = await db.select().from(cwAgentRuns).where(eq(cwAgentRuns.orderId, orderId))
    if (run && statuses.includes(run.status)) return run
    if (Date.now() > end) throw new Error(`Run did not reach ${statuses.join("/")}; now ${run?.status}: ${run?.outcomeSummary}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

ensureAgentService()

// ── Delivery watch built from the dealer's opening hours ────────────────────
await resetScenario()
{
  const [w] = await db.select().from(cwWatches).where(eq(cwWatches.orderId, "ord-00452"))
  assert.equal(w.targetKind, "DELIVERY_WINDOW")
  assert.equal(w.targetLabel, "Kervandorio Tampere")
  assert.equal(w.deadlineAt.toISOString(), "2026-10-21T13:00:00.000Z", "deadline = end of the promised window (16:00 local)")
  assert.equal(w.handover?.callAheadMin, 30)
  assert.equal(w.handover?.deadlineIs, "PROMISE_END")
  assert.ok(w.explanation.some((l) => l.startsWith("Kervandorio Tampere is open 09:00–18:00 local today")), w.explanation.join(" | "))
  const { rollPromiseToClosing } = await import("../lib/watch/watches")
  const rolled = await rollPromiseToClosing(w, new Date("2026-10-21T13:05:00Z"))
  assert.equal(rolled.deadlineAt.toISOString(), "2026-10-21T15:00:00.000Z", "past the promise, the watch guards closing (18:00 local)")
  assert.ok(rolled.handover?.promiseBrokenAt)
  console.log("✔ delivery watch: promise 16:00, open until 18:00, call 30 min ahead; rolls to closing after the promise")
}

// ── Approve path ────────────────────────────────────────────────────────────
await resetScenario()
const model = scripted([
  () => [say("Checking the margin and the booking first."), use("get_watch_status", {}), use("get_travel", {})],
  (sent) => { assert.match(sent, /BOOKED/); return [use("search_sailings", {}), use("search_hotels", {})] },
  (sent) => {
    assert.match(sent, /sail-wb-sf-1021-2200/, "real sailing ids reach the model")
    assert.match(sent, /meets the promise/, "delivery promise judged by code")
    assert.match(sent, /breaks the promise/, "the next-day sailing would break it")
    return [use("propose_action", {
      title: "Rebook to the 22:00 sailing and book a hotel",
      reason: "The car is stuck in a queue before the terminal and will miss the 14:00 check-in. The 22:00 sailing has space and still delivers inside the promise.",
      changes: [
        { kind: "REBOOK_FERRY", label: "Move to the 22:00 sailing", sailing_id: "sail-wb-sf-1021-2200", hotel_id: null, cost_cents: 999999, draft_body: null },
        { kind: "BOOK_HOTEL", label: "Hotel near the terminal for the wait", sailing_id: null, hotel_id: "hotel-wb-1", cost_cents: null, draft_body: null },
      ],
      after_approval: "The agent rebooks, books the hotel and tells the driver. No customer message is needed: delivery stays inside the promise.",
      evidence: ["travel_reservations:res-x1082202e8d139d61", "mock_sailings:sail-wb-sf-1021-2200"],
    })]
  },
  (sent) => {
    assert.match(sent, /approved proposal/, "woken with the decision")
    assert.match(sent, /rebooked to the 22:00 sailing/)
    return [use("message_driver", { text: "New plan: 22:00 sailing, check-in by 20:00 local. Hotel Harbourline Rooms is booked. OK?", quick_replies: ["OK", "Call me"] })]
  },
  () => [use("close_run", { summary: "Rebooked to the 22:00 sailing with a hotel; driver told; delivery promise kept.", evidence: ["cw_watches:cw-res-x1082202e8d139d61"] })],
])
setModelForTesting(model)

await deliver(ORDER, { kind: "trigger", from: "ON_TRACK", to: "AT_RISK", at: new Date().toISOString() }, { start: true, trigger: "AT_RISK" })
const waiting = await settle(ORDER, ["awaiting_decision"])
const [proposal] = await db.select().from(cwProposals).where(eq(cwProposals.orderId, ORDER))
assert.equal(proposal.status, "pending")
assert.equal(proposal.changes[0].costCents, 8500, "cost comes from the quote, not the model's 999999")
assert.equal(proposal.changes[1].costCents, 9200)
assert.equal(proposal.decideByAt?.toISOString(), "2026-10-21T11:25:00.000Z", "decide-by = sales close − booking lead, before the original check-in closes")
assert.ok(proposal.changes.every((c) => c.needsApproval))
console.log("✔ proposal created with costs and decide-by from the quotes:", proposal.title)

const result = await decide(proposal.id, "approved", null, "Aino (test)")
assert.equal(result.status, "executed")
const [watch] = await db.select().from(cwWatches).where(eq(cwWatches.orderId, ORDER))
assert.equal(watch.deadlineAt.toISOString(), "2026-10-21T18:00:00.000Z", "watch now guards the new check-in")
assert.equal(watch.targetRef.table, "cw_bookings")
const bookings = await db.select().from(cwBookings).where(eq(cwBookings.orderId, ORDER))
assert.equal(bookings.length, 2)
console.log("✔ approval rechecked and applied:", result.outcome)

const closed = await settle(ORDER, ["closed"])
assert.match(closed.outcomeSummary ?? "", /Rebooked/)
const msgs = await db.select().from(cwMessages).where(eq(cwMessages.orderId, ORDER))
assert.equal(msgs.filter((m) => m.party === "agent").length, 1)
assert.equal((await db.select().from(cwDrafts).where(eq(cwDrafts.orderId, ORDER))).length, 0, "no customer draft was needed")
assert.ok(existsSync(path.join(TRACE_DIR, `${waiting.id}.jsonl`)), "trace written")
console.log("✔ run resumed after approval, told the driver, closed:", closed.outcomeSummary)

// ── Reject path, and a stale second approval ────────────────────────────────
await resetScenario()
const model2 = scripted([
  () => [use("propose_action", {
    title: "Rebook to the 22:00 sailing", reason: "Test", after_approval: "Rebook and tell the driver.",
    changes: [{ kind: "REBOOK_FERRY", label: "22:00", sailing_id: "sail-wb-sf-1021-2200", hotel_id: null, cost_cents: null, draft_body: null }],
    evidence: ["travel_reservations:res-x1082202e8d139d61"],
  })],
  (sent) => {
    assert.match(sent, /rejected proposal/)
    assert.match(sent, /Wait, the queue is moving/)
    return [use("wait_for", { reason: "See if the queue clears as the operator says", minutes: 20 })]
  },
])
setModelForTesting(model2)
await deliver(ORDER, { kind: "trigger", from: "ON_TRACK", to: "AT_RISK", at: new Date().toISOString() }, { start: true })
await settle(ORDER, ["awaiting_decision"])
const [p2] = await db.select().from(cwProposals).where(eq(cwProposals.orderId, ORDER))
await assert.rejects(decide(p2.id, "rejected", "", "Aino (test)"), /Say why/)
await decide(p2.id, "rejected", "Wait, the queue is moving again", "Aino (test)")
const waitingAgain = await settle(ORDER, ["waiting"])
assert.ok(waitingAgain.waitUntil)
await assert.rejects(decide(p2.id, "approved", null, "Aino (test)"), /already rejected/)
assert.equal((await db.select().from(cwBookings).where(eq(cwBookings.orderId, ORDER))).length, 0, "nothing booked after a reject")
console.log("✔ reject needs a reason, books nothing, wakes the agent with the note; a late approve is refused")

await resetScenario()
console.log("\nAll end-to-end checks passed.")
process.exit(0)

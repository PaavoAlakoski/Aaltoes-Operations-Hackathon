import "server-only"

import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { emit } from "@/lib/watch/bus"
import { simNow } from "@/lib/watch/clock"
import { HOTELS, SAILINGS } from "@/lib/watch/mock/world"
import { cwBookings, cwDrafts, cwProposals, cwWatches } from "@/lib/watch/schema"
import { formatLocal } from "@/lib/watch/slack"
import { orderContext, watchForOrder } from "./context"
import { deliver } from "./service"
import { slotsLeft, useSlot } from "./tools"

// Carries out a person's decision on a proposal. Approve → recheck current state → apply mock
// changes → wake the agent with what was done. A customer message is only ever a draft here.

export type Decision = "approved" | "rejected" | "changed"

export async function decide(proposalId: string, decision: Decision, note: string | null, operator: string): Promise<{ status: string; outcome: string }> {
  const [proposal] = await db.select().from(cwProposals).where(eq(cwProposals.id, proposalId))
  if (!proposal) throw new Error("Proposal not found")
  if (proposal.status !== "pending") throw new Error(`This proposal is already ${proposal.status}`)
  if ((decision === "rejected" || decision === "changed") && !note?.trim()) throw new Error("Say why, so the agent and the next person know")
  const now = await simNow()

  let status: string = decision
  let outcome: string
  if (decision === "rejected") outcome = "Nothing was changed."
  else if (decision === "changed") outcome = "Nothing was changed yet. Revise the proposal using the note, or explain why not."
  else {
    const problem = await recheck(proposal, now)
    if (problem) {
      status = "failed"
      outcome = `Not carried out, because the situation changed: ${problem}. Nothing was booked.`
    } else {
      outcome = await apply(proposal, now)
      status = "executed"
    }
  }

  await db.update(cwProposals).set({ status, reviewedBy: operator, reviewNote: note, reviewedAt: now }).where(eq(cwProposals.id, proposalId))
  emit({ type: "decision", orderId: proposal.orderId, proposalId, decision: status, at: now.toISOString() })
  await deliver(proposal.orderId, { kind: "decision", proposalId, decision, note, operator, outcome, at: now.toISOString() }, { start: false })
  return { status, outcome }
}

type Proposal = typeof cwProposals.$inferSelect

async function recheck(p: Proposal, now: Date): Promise<string | null> {
  const watch = await watchForOrder(p.orderId)
  for (const c of p.changes) {
    if (c.kind === "REBOOK_FERRY") {
      const s = SAILINGS.find((x) => x.id === c.sailingId)
      if (!s) return "the sailing no longer exists"
      if (slotsLeft(s) <= 0) return "the sailing has no vehicle slots left"
      if (new Date(s.salesCloseAt) <= now) return "the carrier has stopped selling that sailing"
      if (watch?.madeAt) return "the car already checked in on the original sailing"
    }
  }
  return null
}

async function apply(p: Proposal, now: Date): Promise<string> {
  const done: string[] = []
  const watch = await watchForOrder(p.orderId)
  const tz = watch?.targetTimezone ?? "UTC"
  for (const [i, c] of p.changes.entries()) {
    const id = `${p.id}-${i}`
    if (c.kind === "REBOOK_FERRY") {
      const s = SAILINGS.find((x) => x.id === c.sailingId)!
      useSlot(s.id)
      const reference = `MOCK-${s.provider.split(" ")[0].toUpperCase()}-${s.id.slice(-9)}`
      await db.insert(cwBookings).values({ id, orderId: p.orderId, proposalId: p.id, kind: "FERRY", label: `${s.provider}, departs ${formatLocal(new Date(s.departureAt), tz)} on ${s.departureAt.slice(0, 10)}`, reference, costCents: s.fareDeltaCents, details: { sailingId: s.id, checkInCutoffAt: s.checkInCutoffAt, departureAt: s.departureAt, replaces: watch?.targetRef ?? null }, createdAt: now })
      // The watch now guards the new check-in. The old booking stays on record as what was replaced.
      if (watch) {
        await db.update(cwWatches).set({ deadlineAt: new Date(s.checkInCutoffAt), departureAt: new Date(s.departureAt), targetRef: { table: "cw_bookings", id }, lastTriggerAt: null }).where(eq(cwWatches.id, watch.id))
      }
      done.push(`rebooked to the ${formatLocal(new Date(s.departureAt), tz)} sailing (${reference}, mock), check-in now closes ${formatLocal(new Date(s.checkInCutoffAt), tz)} local`)
    } else if (c.kind === "BOOK_HOTEL") {
      const h = HOTELS.find((x) => x.id === c.hotelId)!
      await db.insert(cwBookings).values({ id, orderId: p.orderId, proposalId: p.id, kind: "HOTEL", label: h.name, reference: `MOCK-HOTEL-${h.id}`, costCents: h.nightlyCents, details: {}, createdAt: now })
      done.push(`booked ${h.name} (mock, €${h.nightlyCents / 100})`)
    } else if (c.kind === "APPROVE_EXPENSE") {
      await db.insert(cwBookings).values({ id, orderId: p.orderId, proposalId: p.id, kind: "EXPENSE", label: c.label, reference: null, costCents: c.costCents ?? null, details: {}, createdAt: now })
      done.push(`approved the expense "${c.label}"`)
    } else if (c.kind === "DRAFT_CUSTOMER_MESSAGE") {
      const ctx = await orderContext(p.orderId)
      await db.insert(cwDrafts).values({ proposalId: p.id, orderId: p.orderId, recipient: ctx.customer?.name ?? "customer", body: c.draftBody ?? "", status: "ready_to_send", createdAt: now })
      done.push("put the customer message in drafts for a person to send (not sent)")
    } else if (c.kind === "TASK_FOR_PERSON") {
      done.push(`noted the task for a person: ${c.label}`)
    } else if (c.kind === "KEEP_CURRENT_BOOKING") {
      done.push("kept the current booking")
    }
  }
  return `Done: ${done.join("; ")}. Tell the driver what changed for them.`
}

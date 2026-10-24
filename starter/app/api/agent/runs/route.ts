import { desc, eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { ensureServices } from "@/lib/boot"
import { db } from "@/lib/db"
import { stepsForRuns } from "@/lib/agent/store"
import { cwAgentRuns, cwBookings, cwDrafts, cwMessages, cwProposals } from "@/lib/watch/schema"

export const runtime = "nodejs"

// Everything the agent did on an order: runs, steps, proposals, messages, mock bookings, drafts.
export async function GET(request: Request) {
  ensureServices()
  const orderId = new URL(request.url).searchParams.get("order")
  if (!orderId) return NextResponse.json({ error: "Give ?order=" }, { status: 400 })
  const runs = await db.select({
    id: cwAgentRuns.id, trigger: cwAgentRuns.trigger, status: cwAgentRuns.status, outcomeSummary: cwAgentRuns.outcomeSummary,
    waitReason: cwAgentRuns.waitReason, waitUntil: cwAgentRuns.waitUntil, startedAt: cwAgentRuns.startedAt, endedAt: cwAgentRuns.endedAt,
    modelCalls: cwAgentRuns.modelCalls, toolCalls: cwAgentRuns.toolCalls, inputTokens: cwAgentRuns.inputTokens, outputTokens: cwAgentRuns.outputTokens,
  }).from(cwAgentRuns).where(eq(cwAgentRuns.orderId, orderId)).orderBy(desc(cwAgentRuns.startedAt))
  const [steps, proposals, messages, bookings, drafts] = await Promise.all([
    stepsForRuns(runs.map((r) => r.id)),
    db.select().from(cwProposals).where(eq(cwProposals.orderId, orderId)).orderBy(desc(cwProposals.createdAt)),
    db.select().from(cwMessages).where(eq(cwMessages.orderId, orderId)).orderBy(cwMessages.at),
    db.select().from(cwBookings).where(eq(cwBookings.orderId, orderId)),
    db.select().from(cwDrafts).where(eq(cwDrafts.orderId, orderId)),
  ])
  return NextResponse.json({ runs, steps, proposals, messages, bookings, drafts })
}

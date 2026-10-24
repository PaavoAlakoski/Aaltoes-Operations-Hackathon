import { NextResponse } from "next/server"
import { listDecisions, recordDecision } from "@/lib/control-room"
import { deriveAttention } from "@/lib/present/attention"
import { actionsFor, applyDecisions, type DecisionAction, effectsFor } from "@/lib/present/decisions"
import { loadOrder } from "@/lib/present/load"

export const runtime = "nodejs"

type Body = { orderId?: unknown; targetId?: unknown; action?: unknown; note?: unknown }

// Records one decision on an item that is still open on the order. The order is
// re-read first, so a decision is only taken on the current state of the record.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Body | null
  if (!body || typeof body.orderId !== "string" || typeof body.targetId !== "string" || typeof body.action !== "string") {
    return NextResponse.json({ error: "orderId, targetId and action are required" }, { status: 400 })
  }
  const loaded = await loadOrder(body.orderId)
  if (!loaded) return NextResponse.json({ error: "Order not found" }, { status: 404 })
  const { open } = applyDecisions(deriveAttention(loaded.bundle), await listDecisions(body.orderId))
  const item = open.find((entry) => entry.recordId === body.targetId)
  if (!item) return NextResponse.json({ error: "This is no longer open on the order. Reload to see the current state." }, { status: 409 })
  const option = actionsFor(item, loaded.bundle).find((entry) => entry.action === body.action)
  if (!option) return NextResponse.json({ error: "That action is not available here" }, { status: 400 })
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : null
  if (option.needsNote && !note) return NextResponse.json({ error: "Add a short note so the next person knows why" }, { status: 400 })
  const action = body.action as DecisionAction
  const decision = await recordDecision({
    orderId: body.orderId, targetType: item.kind, targetId: item.recordId, action, note,
    effects: effectsFor(item, action, note, loaded.bundle),
  })
  return NextResponse.json({ decision }, { status: 201 })
}

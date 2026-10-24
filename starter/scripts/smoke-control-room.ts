// Checks the control room against a running app (APP_URL, default localhost:3000):
// 1. The queue and every order's case agree on whether the order needs a person.
// 2. A decision round trip: approve a proposal, it leaves the case and the
//    queue's "decide now", a second decision on it is refused, undo restores it.
// 3. No agent step ever contacts a customer: anything for a customer is marked
//    as the person's job.

type QueueRow = { id: string; reference: string; bucket: string }
type Queue = { rows: QueueRow[]; quiet: number; total: number; decided: { id: string }[] }
type Effect = { text: string; needsPerson: boolean }
type CaseItem = { kind: string; recordId: string; proposal: { touchesCustomer: boolean } | null; actions: { action: string; effects: Effect[] }[] }
type Detail = { order: { id: string; reference: string }; case: { open: CaseItem[]; decided: { decision: { id: string } }[] } }

const base = process.env.APP_URL ?? "http://localhost:3000"

async function json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, init)
  const text = await response.text()
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main(): Promise<void> {
  const { body: queue } = await json<Queue>("/api/queue")
  check(queue.rows.length + queue.quiet === queue.total, "queue rows and quiet orders do not add up to all orders")
  const listed = new Set(queue.rows.map((row) => row.id))

  const { body: board } = await json<{ visible: { id: string }[] }>("/api/overview")
  let proposalTarget: { orderId: string; recordId: string } | null = null
  for (const card of board.visible) {
    const { body: detail } = await json<Detail>(`/api/orders/${card.id}`)
    const needs = detail.case.open.length > 0
    check(needs === listed.has(card.id), `${detail.order.reference}: queue says ${listed.has(card.id) ? "needs a person" : "quiet"}, case has ${detail.case.open.length} open items`)
    for (const item of detail.case.open) {
      for (const option of item.actions) for (const effect of option.effects) {
        const mentionsCustomer = /customer/i.test(effect.text)
        check(!mentionsCustomer || effect.needsPerson || /stays|ask the customer first|no other order/i.test(effect.text),
          `${detail.order.reference}: an agent step mentions the customer without handing it to a person: “${effect.text}”`)
      }
      if (item.proposal?.touchesCustomer) {
        const approve = item.actions.find((option) => option.action === "approve")
        check(approve?.effects.some((effect) => effect.needsPerson), `${detail.order.reference}: approving a customer-facing proposal does not leave the customer step to a person`)
      }
      if (!proposalTarget && item.kind === "proposal" && item.actions.some((option) => option.action === "approve")) proposalTarget = { orderId: card.id, recordId: item.recordId }
    }
  }
  console.log(`Queue and case agree on all ${board.visible.length} orders; ${listed.size} need a person.`)

  check(proposalTarget, "no open agent proposal to test a decision on")
  const decide = (action: string) => json<{ decision?: { id: string }; error?: string }>("/api/decisions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: proposalTarget!.orderId, targetId: proposalTarget!.recordId, action }),
  })
  const first = await decide("approve")
  check(first.status === 201 && first.body.decision, `approve returned ${first.status}`)
  const { body: after } = await json<Detail>(`/api/orders/${proposalTarget.orderId}`)
  check(!after.case.open.some((item) => item.recordId === proposalTarget!.recordId), "the approved proposal is still open on the case")
  check(after.case.decided.some((entry) => entry.decision.id === first.body.decision!.id), "the decision is not shown on the case")
  const again = await decide("approve")
  check(again.status === 409, `a second decision on the same proposal returned ${again.status}, expected 409`)
  const undo = await fetch(`${base}/api/decisions/${first.body.decision.id}`, { method: "DELETE" })
  check(undo.status === 204, `undo returned ${undo.status}`)
  const { body: restored } = await json<Detail>(`/api/orders/${proposalTarget.orderId}`)
  check(restored.case.open.some((item) => item.recordId === proposalTarget!.recordId), "undo did not bring the proposal back")
  console.log(`Decision round trip on ${restored.order.reference}: approve, refuse a stale second decision, undo.`)
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })

// What a person decided in the control room, and what follows from it. A
// decision is recorded beside the snapshot; it never rewrites a source record.
// The effects are simulated: nothing outside this app is contacted.

import { type Bundle, list, obj, rows, str, strings } from "./bundle"
import { humanize, label } from "./labels"
import type { AttentionItem, Row } from "./types"

export type DecisionAction = "approve" | "change" | "reject" | "take_over" | "done" | "retry" | "link" | "not_this_order"

export type DecisionEffect = { text: string; needsPerson: boolean }

export type DecisionRecord = {
  id: string
  orderId: string
  targetType: string
  targetId: string
  action: DecisionAction
  note: string | null
  decidedBy: string
  decidedAt: string
  effects: DecisionEffect[]
}

export const ACTION_LABELS: Record<DecisionAction, string> = {
  approve: "Approved", change: "Approved with changes", reject: "Rejected", take_over: "Taken over",
  done: "Marked handled", retry: "Sent back to retry", link: "Linked to this order", not_this_order: "Marked as not this order",
}

/** The actions a person can take on one attention item, best first. */
export type ActionOption = { action: DecisionAction; label: string; needsNote: boolean; primary: boolean; hint: string }

export function actionsFor(item: AttentionItem, bundle: Bundle): ActionOption[] {
  if (item.kind === "proposal") {
    const proposal = rows(bundle, "agent_proposals").find((row) => row.id === item.recordId)
    const status = str(proposal?.details.status)
    if (status === "FAILED") return [
      { action: "retry", label: "Retry", needsNote: false, primary: true, hint: "The agent tries again after checking the order is unchanged." },
      { action: "take_over", label: "I'll handle it", needsNote: false, primary: false, hint: "The agent stops; you own the next step." },
      { action: "done", label: "Already sorted", needsNote: true, primary: false, hint: "Say how it was reconciled." },
    ]
    if (status === "APPROVED_AWAITING_EXECUTION") return [
      { action: "approve", label: "Run it now", needsNote: false, primary: true, hint: "The agent carries out the approved step." },
      { action: "reject", label: "Cancel", needsNote: true, primary: false, hint: "Say why it should not run." },
    ]
    return [
      { action: "approve", label: "Approve", needsNote: false, primary: true, hint: "The agent carries out exactly this." },
      { action: "change", label: "Change", needsNote: true, primary: false, hint: "Tell the agent what to do instead." },
      { action: "reject", label: "Reject", needsNote: true, primary: false, hint: "Nothing changes. Say why, so the agent learns." },
    ]
  }
  if (item.kind === "inbox") {
    const thread = bundle.inboxThreads.find((row) => row.id === item.recordId)
    const confirmed = strings(thread?.details.linked_order_ids).includes(bundle.order.id)
    if (!confirmed) return [
      { action: "link", label: "Yes, it's this order", needsNote: false, primary: true, hint: "Files the message on this order." },
      { action: "not_this_order", label: "Not this order", needsNote: false, primary: false, hint: "It stays in the inbox for someone else." },
    ]
  }
  return [
    { action: "take_over", label: "I'll take it", needsNote: false, primary: true, hint: "You become the owner of the next step." },
    { action: "done", label: "Mark handled", needsNote: true, primary: false, hint: "Say what was done. The source record keeps its own status." },
  ]
}

// Plain words for the payload keys our agents use. Unknown keys fall back to their field name.
const PAYLOAD_WORDS: Record<string, (value: unknown) => string | null> = {
  hold_collection: (v) => v ? "Collection stays on hold" : null,
  do_not_mark_picked_up: (v) => v ? "The car is not marked as picked up" : null,
  // The agent may ask drivers and sites itself. A customer is only ever drafted for, never contacted.
  contact: (v) => {
    const others = list(v).map((who) => String(who)).filter((who) => who !== "customer")
    return others.length ? `Ask the ${others.join(" and ")}` : null
  },
  check_replacement_capacity: (v) => v ? "Check whether a replacement driver could make it" : null,
  keep_current_assignment_until_decision: (v) => v ? "The current driver stays booked until you decide" : null,
  request_customer_approval_if_window_changes: (v) => v ? "If the window moves, ask the customer first" : null,
  do_not_change_delivery_promise: (v) => v ? "The delivery promise stays as it is" : null,
  refresh_next_day_capacity: (v) => v ? "Re-check next-day ferry capacity" : null,
  verify_provider_reference: (v) => v ? "Confirm the provider's booking reference" : null,
  do_not_assign_liability: (v) => v ? "No one is blamed for the damage yet" : null,
  request_signed_handover: (v) => v ? "Ask for the signed handover" : null,
  review_pickup_and_delivery_photos: (v) => v ? "Compare pickup and delivery photos" : null,
  change_promise: (v) => v ? "Change the delivery promise" : "The delivery promise stays as it is",
  refresh_capacity: (v) => v ? "Re-check capacity" : null,
  verify_driver_rest: (v) => v ? "Check the driver gets the rest they need" : null,
  buy_ticket: (v) => v ? "Buy the ticket" : "No ticket is bought",
  look_for_backup: (v) => v ? "Find a named backup driver" : null,
  cancel_current: (v) => v ? "Cancel the current driver" : "The current driver stays booked",
  check_invoice_record: (v) => v ? "Ask billing to find the invoice record" : null,
  tell_customer_issued: (v) => v ? "Tell the customer the invoice was issued" : null,
  vehicle_space_required: (v) => v ? "Only a sailing with vehicle space counts" : null,
  use_first_available: (v) => v ? "Take the first available replacement" : null,
  mark_boarding_confirmed: (v) => v ? "Mark boarding as confirmed" : null,
  authorize_restart: (v) => v ? "Tell the driver they may restart the car" : null,
}

const SKIP_KEYS = new Set(["travel_option_id", "option_id", "replace_reservation_id", "alert_id", "passenger_assignment_id", "source_message_id", "message"])

/** The proposal's payload as plain steps. */
export function payloadSteps(payload: Row | null): string[] {
  if (!payload) return []
  const steps: string[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (SKIP_KEYS.has(key)) continue
    const words = PAYLOAD_WORDS[key]
    const text = words ? words(value) : value === true ? humanize(key) : value === false ? null : `${humanize(key)}: ${String(value)}`
    if (text) steps.push(text)
  }
  if (typeof payload.message === "string") steps.push(`Send the driver: “${payload.message}”`)
  return steps
}

/** Whether a proposal would reach a customer: the agent may never do that on its own. */
export function touchesCustomer(payload: Row | null): boolean {
  if (!payload) return false
  if (list(payload.contact).some((who) => String(who) === "customer")) return true
  return Object.entries(payload).some(([key, value]) => key.includes("customer") && value === true)
}

/** What happens after a decision, in the order it happens. */
export function effectsFor(item: AttentionItem, action: DecisionAction, note: string | null, bundle: Bundle): DecisionEffect[] {
  const effects: DecisionEffect[] = []
  const proposal = item.kind === "proposal" ? rows(bundle, "agent_proposals").find((row) => row.id === item.recordId) : null
  const payload = obj(proposal?.details.proposed_payload) ?? null
  const finalPayload = obj(obj(proposal?.details.review)?.final_payload) ?? payload
  const agent = proposal ? bundle.dir.title(proposal.details.proposed_by_agent_id) ?? "The agent" : "The agent"
  const recheck = str(obj(proposal?.details.dependency)?.execution_policy) === "RECHECK_CURRENT_STATE_BEFORE_WRITE"

  switch (action) {
    case "approve":
    case "change":
    case "retry": {
      if (recheck || action === "retry") effects.push({ text: `${agent} first checks that nothing on the order changed since it proposed this. If something did, it stops and comes back to you.`, needsPerson: false })
      if (action === "change" && note) effects.push({ text: `${agent} follows your instruction: “${note}”`, needsPerson: false })
      for (const step of payloadSteps(action === "change" ? payload : finalPayload)) effects.push({ text: step, needsPerson: false })
      if (touchesCustomer(finalPayload)) effects.push({ text: "Anything for the customer is drafted for you. Nothing reaches them until you send it.", needsPerson: true })
      effects.push({ text: "The result appears on this order, with what was changed and who did it.", needsPerson: false })
      break
    }
    case "reject":
      effects.push({ text: "Nothing changes on the order.", needsPerson: false })
      effects.push({ text: `${agent} keeps your reason${note ? `: “${note}”` : ""}, and does not propose the same thing again without new evidence.`, needsPerson: false })
      break
    case "take_over":
      effects.push({ text: "You own the next step. It stays on your list until you mark it handled.", needsPerson: true })
      if (item.kind === "proposal") effects.push({ text: `${agent} stops working on it.`, needsPerson: false })
      break
    case "done":
      effects.push({ text: "It leaves the list.", needsPerson: false })
      effects.push({ text: `Your note is kept on the order${note ? `: “${note}”` : ""}. The ${label(item.kind).toLowerCase()} record itself keeps its own status.`, needsPerson: false })
      break
    case "link":
      effects.push({ text: "The message is filed on this order and leaves the unmatched inbox.", needsPerson: false })
      effects.push({ text: "No other order's details are shared with the sender.", needsPerson: false })
      break
    case "not_this_order":
      effects.push({ text: "The message stays in the inbox with this order ruled out.", needsPerson: false })
      break
  }
  return effects
}

/**
 * Attention with the decisions laid over it. A decided item leaves the list;
 * a taken-over item stays with you as its owner. The latest decision on a target wins.
 */
export function applyDecisions(items: AttentionItem[], decisions: DecisionRecord[]): { open: AttentionItem[]; decided: { item: AttentionItem; decision: DecisionRecord }[] } {
  const latest = new Map<string, DecisionRecord>()
  for (const decision of [...decisions].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))) latest.set(decision.targetId, decision)
  const open: AttentionItem[] = []
  const decided: { item: AttentionItem; decision: DecisionRecord }[] = []
  for (const item of items) {
    const decision = latest.get(item.recordId)
    if (!decision) { open.push(item); continue }
    if (decision.action === "take_over") {
      open.push({ ...item, tone: item.tone === "danger" ? "warn" : item.tone, owner: "You", short: `${item.short.split(" · ")[0]} · you` })
    }
    decided.push({ item, decision })
  }
  return { open, decided }
}

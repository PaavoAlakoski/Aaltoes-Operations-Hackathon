// The "Needs you" queue: every order that is waiting on a person, with why, the
// next step and the clock that decides it. Built on the same attention items as
// the order record, so the queue and the record never disagree.

import { deriveAttention, deriveKeyDates, sortAttention, strongestTone } from "./attention"
import { buildBoardCard } from "./board"
import { type Bundle, rows, str } from "./bundle"
import { applyDecisions, type DecisionRecord } from "./decisions"
import { laneLabel } from "./labels"
import { fmtDateTime, relativeTo } from "./time"
import type { AttentionItem, KeyDate, Tone } from "./types"

export type Bucket = "decide" | "follow_up" | "waiting" | "quiet"

export const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: "decide", label: "Decide now", hint: "Something is at risk or an agent is waiting for your yes." },
  { key: "follow_up", label: "Follow up", hint: "Open checks and conversations with no one else to wait for." },
  { key: "waiting", label: "Waiting on others", hint: "Someone owns it or an answer is due. Check back at the time shown." },
]

export type AgentNote = { name: string; text: string; tone: Tone }

export type QueueRow = {
  id: string
  reference: string
  vehicle: string
  customer: string
  from: string
  to: string
  lane: string
  laneLabel: string
  bucket: Bucket
  tone: Tone
  /** The one thing that needs a person, in a few words. */
  reason: string
  /** What the record says about it. */
  why: string | null
  /** The next step, and whether a record, an agent or the playbook supplied it. */
  next: NextStep | null
  owner: string | null
  /** Where the next step came from, for example "work item, due 21 Oct 09:10". */
  source: string
  agent: AgentNote | null
  clock: KeyDate | null
  more: number
  desks: string[]
  decidedCount: number
  search: string
}

export type DecidedRow = { id: string; orderId: string; reference: string; vehicle: string; actionLabel: string; what: string; at: string; next: string | null; needsPerson: boolean }

export type QueueView = {
  snapshotAt: string | null
  total: number
  quiet: number
  counts: Record<Bucket, number>
  rows: QueueRow[]
  desks: { name: string; count: number }[]
  decided: DecidedRow[]
}

const TONE_RANK: Record<Tone, number> = { danger: 0, warn: 1, accent: 2, neutral: 3, ok: 4 }
const WAITING_KINDS = new Set<AttentionItem["kind"]>(["waiting", "owned_alert", "inbox"])

function bucketOf(items: AttentionItem[]): Bucket {
  if (!items.length) return "quiet"
  if (items.some((item) => item.tone === "danger" || item.tone === "warn" || item.kind === "proposal")) return "decide"
  if (items.every((item) => WAITING_KINDS.has(item.kind) && item.owner !== "You")) return "waiting"
  return "follow_up"
}

export type NextStep = { text: string; from: "record" | "agent" | "playbook" }

// The usual first move for each alert signal, used only when no record names a
// next step. Shown as "playbook" so nobody mistakes it for a recorded instruction.
const PLAYBOOK: Record<string, string> = {
  DELIVERY_PROMISE_UNACHIEVABLE: "Confirm the new ETA with the driver, then decide what to tell the customer. Nothing goes to them without you.",
  DELIVERY_ACCESS_RISK: "Confirm who can receive the car and how to get in before the driver arrives.",
  TRACKING_GAP: "Ask the driver for a position before changing any promise. A gap is not a breakdown.",
  FERRY_CONNECTION_RISK: "Check whether the driver can still make check-in; compare the next sailing with space.",
  RELEASE_DOCUMENT_UNCLEAR: "Get the signed release from the seller before anyone travels. A car on site is not permission to take it.",
  SITE_ACCESS_UNCONFIRMED: "Ask the site to confirm the entrance and opening hours for this car.",
  SITE_ACCESS_CONFLICT: "Settle which entrance and contact are current before the driver relies on them.",
  DRIVER_AVAILABILITY_RISK: "Check the driver is fit and on time; line up a backup if not.",
  PROOF_REVIEW: "Review the submitted proof and approve or reject it with a reason.",
  CONDITION_CLAIM_REVIEW: "Compare pickup and delivery photos. Do not assign blame from photos alone.",
  CONDITION_CLAIM: "Collect the evidence from both ends. Do not assign blame from photos alone.",
  INVOICE_REFERENCE_QUERY: "Find the invoice record before telling the customer anything about it.",
}

/** The next step for one item: from its own record, then from an agent's pending proposal or open work on the order, then the playbook. */
export function nextStep(item: AttentionItem, bundle: Bundle, decided: Set<string> = new Set()): NextStep | null {
  const find = (collection: string) => rows(bundle, collection).find((row) => row.id === item.recordId)?.details
  const pendingProposal = rows(bundle, "agent_proposals").find((row) => row.details.status === "PENDING_REVIEW" && !decided.has(row.id))
  const openWork = rows(bundle, "work_items").find((row) => row.details.status !== "DONE" && str(row.details.next_action) && !decided.has(row.id))
  const record = (text: string | null | undefined): NextStep | null => text ? { text, from: "record" } : null
  const fallback = (): NextStep | null =>
    pendingProposal ? { text: `Review the agent's proposal: ${str(pendingProposal.details.summary)}`, from: "agent" }
    : openWork ? { text: str(openWork.details.next_action)!, from: "record" } : null
  switch (item.kind) {
    case "work": return record(str(find("work_items")?.next_action) ?? item.detail)
    case "incident": return fallback() ?? { text: "Decide how to recover the job.", from: "playbook" }
    case "proposal": {
      const proposal = find("agent_proposals")
      const status = str(proposal?.status)
      if (status === "FAILED") return { text: "The agent's action failed. Retry it or take it over.", from: "agent" }
      if (status === "APPROVED_AWAITING_EXECUTION") return { text: `Approved, not yet run: ${str(proposal?.summary)}`, from: "agent" }
      return { text: `Approve or change: ${str(proposal?.summary)}`, from: "agent" }
    }
    case "alert":
    case "owned_alert": {
      const alert = bundle.alerts.find((row) => row.id === item.recordId)
      const linked = rows(bundle, "agent_proposals").find((row) => row.details.alert_id === item.recordId && row.details.status === "PENDING_REVIEW" && !decided.has(row.id))
      if (linked) return { text: `Review the agent's proposal: ${str(linked.details.summary)}`, from: "agent" }
      const own = record(str(alert?.details.next_action))
      if (own) return own
      const other = fallback()
      if (other) return other
      if (item.kind === "owned_alert") return { text: `${item.owner ?? "The owner"} is on it. Check that it is moving.`, from: "playbook" }
      const play = alert ? PLAYBOOK[alert.signal] : undefined
      return { text: play ?? "Look into the signal before changing anything.", from: "playbook" }
    }
    case "waiting": {
      const thread = bundle.conversations.find((row) => row.id === item.recordId)
      const at = str(thread?.details.next_check_at)
      return { text: at ? `Check for an answer at ${fmtDateTime(at, null)}.` : "Check whether an answer has come in.", from: at ? "record" : "playbook" }
    }
    case "conversation": return fallback() ?? { text: "Read the thread, then reply or close it.", from: "playbook" }
    case "claim": return { text: "Decide which statement is current before the driver relies on it.", from: "playbook" }
    case "custody":
    case "check": return record(item.detail)
    case "inbox": return { text: "Confirm whether the message belongs to this order.", from: "playbook" }
  }
}

function sourceLine(item: AttentionItem, snapshotAt: string | null): string {
  const kind = ({
    alert: "Alert", owned_alert: "Alert", work: "Work item", incident: "Incident", waiting: "Conversation", conversation: "Conversation",
    proposal: "Agent proposal", claim: "Claim", custody: "Custody record", check: "Derived from the records", inbox: "Support inbox",
  } as const)[item.kind]
  const when = item.at && item.atLabel ? `${item.atLabel} ${relativeTo(item.at, snapshotAt)?.text ?? fmtDateTime(item.at)}` : null
  return [kind, when].filter(Boolean).join(", ")
}

/** What an agent has done or proposed on this order, in one line. */
function agentNote(bundle: Bundle): AgentNote | null {
  const proposals = rows(bundle, "agent_proposals").map((row) => row.details)
  const by = (row: Record<string, unknown>) => bundle.dir.title(row.proposed_by_agent_id) ?? "Agent"
  const failed = proposals.find((row) => row.status === "FAILED")
  if (failed) return { name: by(failed), text: "action failed", tone: "danger" }
  const pending = proposals.find((row) => row.status === "PENDING_REVIEW")
  if (pending) return { name: by(pending), text: "waiting for your yes", tone: "accent" }
  const approved = proposals.find((row) => row.status === "APPROVED_AWAITING_EXECUTION")
  if (approved) return { name: by(approved), text: "approved, about to run", tone: "accent" }
  const done = proposals.find((row) => row.status === "EXECUTED")
  if (done) return { name: by(done), text: "did the legwork", tone: "neutral" }
  const watched = rows(bundle, "internal_notifications").map((row) => bundle.dir.resolve(row.details.actor_id)).find((actor) => actor.kind === "agent")
  if (watched) return { name: watched.name, text: "watching", tone: "neutral" }
  return null
}

export function buildQueueRow(bundle: Bundle, decisions: DecisionRecord[]): QueueRow & { decidedItems: ReturnType<typeof applyDecisions>["decided"] } {
  const card = buildBoardCard(bundle)
  const { open, decided } = applyDecisions(deriveAttention(bundle), decisions)
  const items = sortAttention(open)
  const top = items[0] ?? null
  const { decisive } = deriveKeyDates(bundle)
  const desks = [...new Set(items.map((item) => item.owner).filter((owner): owner is string => !!owner && owner !== "owner not recorded"))]
  return {
    id: card.id,
    reference: card.reference,
    vehicle: card.vehicle,
    customer: card.customer,
    from: card.from.city,
    to: card.to.city,
    lane: card.displayLane,
    laneLabel: laneLabel(card.displayLane),
    bucket: bucketOf(items),
    tone: items.length ? strongestTone(items.map((item) => item.tone)) : "ok",
    reason: top ? top.title.replace(/^Open alert: /, "").replace(/^Open conversation: /, "Open thread: ") : "On track",
    why: top?.detail ?? null,
    next: top ? nextStep(top, bundle, new Set(decided.map(({ decision }) => decision.targetId))) : null,
    owner: top?.owner ?? null,
    source: top ? sourceLine(top, bundle.snapshotAt) : "",
    agent: agentNote(bundle),
    clock: decisive,
    more: Math.max(0, items.length - 1),
    desks,
    decidedCount: decided.length,
    search: [card.reference, card.customer, card.vehicle, card.origin, card.destination, card.plate ?? "", ...items.map((item) => item.title), ...desks].join(" ").toLowerCase(),
    decidedItems: decided,
  }
}

/** Danger first, then the clock: the sooner the deciding date, the higher. */
function urgency(row: QueueRow, snapshotAt: string | null): number {
  const minutes = row.clock ? relativeTo(row.clock.end ?? row.clock.start, snapshotAt)?.minutes ?? 1e7 : 1e7
  // A date already behind us still matters, but less than one about to pass.
  const timeScore = minutes < 0 ? 5e6 - minutes : minutes
  return TONE_RANK[row.tone] * 1e8 + timeScore
}

export function buildQueue(bundles: Bundle[], decisions: DecisionRecord[], snapshotAt: string | null): QueueView {
  const byOrder = Map.groupBy(decisions, (decision) => decision.orderId)
  const built = bundles.map((bundle) => buildQueueRow(bundle, byOrder.get(bundle.order.id) ?? []))
  const active = built.filter((row) => row.bucket !== "quiet").sort((a, b) => urgency(a, snapshotAt) - urgency(b, snapshotAt))
  const counts: Record<Bucket, number> = { decide: 0, follow_up: 0, waiting: 0, quiet: 0 }
  for (const row of built) counts[row.bucket] += 1
  const deskCounts = new Map<string, number>()
  for (const row of active) for (const desk of row.desks) deskCounts.set(desk, (deskCounts.get(desk) ?? 0) + 1)
  const decidedRows: DecidedRow[] = built.flatMap((row) => row.decidedItems.map(({ item, decision }) => {
    const handOff = decision.effects.find((effect) => effect.needsPerson)
    return {
      id: decision.id, orderId: row.id, reference: row.reference, vehicle: row.vehicle,
      actionLabel: ({ approve: "Approved", change: "Changed", reject: "Rejected", take_over: "Taken over", done: "Handled", retry: "Retry", link: "Linked", not_this_order: "Ruled out" } as const)[decision.action],
      what: item.title, at: decision.decidedAt,
      next: handOff?.text ?? decision.effects[0]?.text ?? null, needsPerson: !!handOff,
    }
  })).sort((a, b) => b.at.localeCompare(a.at))
  return {
    snapshotAt,
    total: bundles.length,
    quiet: counts.quiet,
    counts,
    rows: active.map(({ decidedItems: _, ...row }) => row),
    desks: [...deskCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    decided: decidedRows,
  }
}

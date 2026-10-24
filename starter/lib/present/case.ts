// The order as a case: what needs a person (with the evidence behind it and what
// each choice would do), the facts with where each came from, and one story of
// who said and did what. Built on the record view; nothing here is new truth.

import { deriveAttention, sortAttention } from "./attention"
import { type Bundle, list, obj, rows, str } from "./bundle"
import { actionsFor, ACTION_LABELS, applyDecisions, type ActionOption, type DecisionEffect, type DecisionRecord, effectsFor, payloadSteps, touchesCustomer } from "./decisions"
import { label } from "./labels"
import { type NextStep, nextStep } from "./triage"
import { fmtDateTime, fmtRange } from "./time"
import type { Actor, AttentionItem, RecordView, Tone } from "./types"

export type EvidenceRef = { table: string; id: string; kind: string; text: string; who: string | null; at: string | null }

export type CaseAction = ActionOption & { effects: DecisionEffect[] }

export type CaseItem = AttentionItem & {
  next: NextStep | null
  sourceKind: string
  evidence: EvidenceRef[]
  actions: CaseAction[]
  proposal: null | {
    agent: string
    summary: string
    rationale: string | null
    steps: string[]
    touchesCustomer: boolean
    recheck: boolean
    statusLabel: string
    priorReview: string | null
    error: string | null
  }
}

export type DecidedItem = { item: AttentionItem; decision: DecisionRecord; actionLabel: string }

/** How sure a fact is. Only "confirmed" rests on a recorded confirmation or physical event. */
export type Certainty = "confirmed" | "stated" | "planned" | "quoted" | "missing"

export type FactRow = { label: string; value: string; certainty: Certainty; source: string; at: string | null; tone: Tone }
export type FactGroup = { title: string; icon: string; rows: FactRow[] }

export type TimelineEntry = {
  id: string
  at: string
  kind: "message" | "event" | "proposal" | "review" | "room" | "decision" | "note"
  actor: Actor
  title: string
  body: string | null
  meta: string | null
  internal: boolean
  tone: Tone
}

export type CaseView = { open: CaseItem[]; decided: DecidedItem[]; facts: FactGroup[]; timeline: TimelineEntry[] }

const SOURCE_KIND: Record<AttentionItem["kind"], string> = {
  alert: "Alert", owned_alert: "Alert", work: "Work item", incident: "Incident", waiting: "Conversation", conversation: "Conversation",
  proposal: "Agent proposal", claim: "Claim", custody: "Custody record", check: "Check derived from the records", inbox: "Support inbox",
}

const SYSTEM: Actor = { id: null, kind: "system", name: "System", role: null }

function refsOf(value: unknown): { table: string; id: string }[] {
  return list(value).flatMap((entry) => {
    if (typeof entry === "string") return [{ table: guessTable(entry), id: entry }]
    const row = obj(entry)
    return row && typeof row.id === "string" ? [{ table: String(row.table ?? guessTable(row.id)), id: row.id }] : []
  })
}

function guessTable(id: string): string {
  const prefix = id.split("-")[0]
  return ({ msg: "messages", evt: "operational_events", alert: "alerts", track: "tracking_observations", conv: "conversations", offer: "market_offers", travel: "travel_options", res: "travel_reservations", asg: "work_assignments", proof: "proofs", doc: "documents", incident: "incidents", work: "work_items" } as Record<string, string>)[prefix] ?? "records"
}

/** One cited record in a sentence a person can check. */
function resolveRef(bundle: Bundle, ref: { table: string; id: string }): EvidenceRef {
  const base = { table: ref.table, id: ref.id }
  if (ref.table === "messages") {
    const message = bundle.messages.find((row) => row.id === ref.id)
    if (message) {
      const author = bundle.dir.resolve(message.details.author_id, message.authorType)
      return { ...base, kind: "Message", text: message.body, who: str(message.details.author_name_snapshot) ?? author.name, at: message.authoredAt }
    }
  }
  if (ref.table === "operational_events") {
    const event = bundle.events.find((row) => row.id === ref.id)
    if (event) return { ...base, kind: "Event", text: label(event.command), who: str(event.details.actor_id) ? bundle.dir.resolve(event.details.actor_id, event.details.actor_type).name : null, at: event.recordedAt }
  }
  if (ref.table === "alerts") {
    const alert = bundle.alerts.find((row) => row.id === ref.id)
    if (alert) return { ...base, kind: "Alert", text: `${label(alert.signal)}: ${alert.summary}`, who: "Journey monitor", at: alert.triggeredAt }
  }
  if (ref.table === "orders") return { ...base, kind: "Order", text: `The order record ${bundle.order.reference}`, who: null, at: bundle.order.updatedAt }
  const row = rows(bundle, ref.table).find((record) => record.id === ref.id)
  if (row) {
    const d = row.details
    const text = str(d.summary) ?? str(d.note) ?? str(d.claim) ?? str(d.report) ?? str(d.preview)
      ?? [label(str(d.kind) ?? str(d.type) ?? ref.table), str(d.status) ? label(str(d.status)) : null, str(d.provider), str(d.route_label)].filter(Boolean).join(" · ")
    const at = str(d.checked_at) ?? str(d.observed_at) ?? str(d.recorded_at) ?? str(d.published_at) ?? str(d.created_at) ?? str(d.opened_at) ?? null
    return { ...base, kind: label(ref.table.replace(/s$/, "")), text, who: str(d.source) ? label(str(d.source)) : null, at }
  }
  return { ...base, kind: label(ref.table.replace(/s$/, "")), text: "Cited record not in this order's view", who: null, at: null }
}

function evidenceFor(item: AttentionItem, bundle: Bundle): EvidenceRef[] {
  const find = (collection: string) => rows(bundle, collection).find((row) => row.id === item.recordId)?.details
  let refs: { table: string; id: string }[] = []
  if (item.kind === "proposal") refs = refsOf(find("agent_proposals")?.evidence_refs)
  else if (item.kind === "work") refs = refsOf(find("work_items")?.source_refs)
  else if (item.kind === "alert" || item.kind === "owned_alert") {
    const alert = bundle.alerts.find((row) => row.id === item.recordId)
    refs = refsOf(alert?.details.evidence_refs)
    const thread = str(alert?.details.conversation_id)
    const last = thread ? [...bundle.messages].filter((message) => message.conversationId === thread).pop() : undefined
    if (last) refs.push({ table: "messages", id: last.id })
  } else if (item.kind === "waiting" || item.kind === "conversation") {
    const last = [...bundle.messages].filter((message) => message.conversationId === item.recordId).slice(-2)
    refs = last.map((message) => ({ table: "messages", id: message.id }))
  } else if (item.kind === "claim") {
    const claim = find("endpoint_claims")
    const source = str(claim?.source_id)
    if (source) refs = [{ table: guessTable(source), id: source }]
  } else if (item.kind === "incident") {
    const events = bundle.events.filter((event) => event.targetId === item.recordId).slice(0, 3)
    refs = events.map((event) => ({ table: "operational_events", id: event.id }))
  }
  const seen = new Set<string>()
  return refs.filter((ref) => !seen.has(ref.id) && seen.add(ref.id)).slice(0, 6).map((ref) => resolveRef(bundle, ref))
}

function caseItem(item: AttentionItem, bundle: Bundle, decided: Set<string>): CaseItem {
  const proposalRow = item.kind === "proposal" ? rows(bundle, "agent_proposals").find((row) => row.id === item.recordId)?.details : undefined
  const payload = obj(proposalRow?.proposed_payload)
  const review = obj(proposalRow?.review)
  const execution = obj(proposalRow?.execution)
  return {
    ...item,
    next: nextStep(item, bundle, decided),
    sourceKind: SOURCE_KIND[item.kind],
    evidence: evidenceFor(item, bundle),
    actions: actionsFor(item, bundle).map((option) => ({ ...option, effects: effectsFor(item, option.action, option.needsNote ? "…" : null, bundle) })),
    proposal: proposalRow ? {
      agent: bundle.dir.title(proposalRow.proposed_by_agent_id) ?? "Agent",
      summary: str(proposalRow.summary) ?? "",
      rationale: str(proposalRow.rationale),
      steps: payloadSteps(obj(review?.final_payload) ?? payload),
      touchesCustomer: touchesCustomer(payload),
      recheck: str(obj(proposalRow.dependency)?.execution_policy) === "RECHECK_CURRENT_STATE_BEFORE_WRITE",
      statusLabel: label(str(proposalRow.status)),
      priorReview: review ? `${label(str(review.decision))} by ${bundle.dir.title(review.reviewer_id) ?? "an operator"}${str(review.decision_note) ? `: “${str(review.decision_note)}”` : ""}` : null,
      error: str(execution?.error),
    } : null,
  }
}

/** A site profile describes the standard procedure; only a reply about this order confirms it. */
const orderSpecific = (source: string | null) => !!source && source !== "MANAGED_SITE_PROFILE"

function buildFacts(view: RecordView): FactGroup[] {
  const groups: FactGroup[] = []
  const first = view.journey.groups[0]
  const pickup = first?.steps.find((step) => step.role === "PICKUP")
  const delivery = first ? [...first.steps].reverse().find((step) => step.role === "DELIVERY") : undefined
  const sourceWord = (source: string | null) => source === "CUSTOMER" ? "the customer" : source === "OPS" ? "Ops (not customer-approved)" : source === "SYSTEM" ? "a system estimate" : source === "SITE" ? "the site" : "source not recorded"

  for (const [step, title, icon] of [[pickup, "Pickup", "pin"], [delivery, "Delivery", "flag"]] as const) {
    if (!step) continue
    const facts: FactRow[] = []
    facts.push({ label: "Place", value: `${step.place.name}, ${step.place.city}`, certainty: step.place.addressLine ? "stated" : "missing", source: step.site ? "managed site profile" : step.place.addressLine ? "order address" : "street not supplied", at: null, tone: step.place.addressLine ? "neutral" : "warn" })
    if (step.recorded) facts.push({ label: step.recorded.label, value: fmtDateTime(step.recorded.at), certainty: "confirmed", source: step.recorded.actor ? `reported by ${step.recorded.actor}` : "recorded event", at: step.recorded.at, tone: "ok" })
    const slot = step.windows.find((window) => window.selected) ?? step.windows[0]
    if (slot && !step.recorded) facts.push({ label: slot.label, value: slot.end ? fmtRange(slot.start, slot.end, slot.zone) : fmtDateTime(slot.start, slot.zone), certainty: slot.source === "CUSTOMER" || slot.source === "SITE" ? "stated" : "planned", source: `from ${sourceWord(slot.source)}`, at: null, tone: "neutral" })
    if (step.contact && !step.recorded) facts.push({
      label: "Contact", value: step.contact.name ?? "Not supplied",
      certainty: step.contact.status === "CONFIRMED" ? (orderSpecific(step.contact.source) ? "confirmed" : "stated") : step.contact.name ? "stated" : "missing",
      source: step.contact.status === "CONFIRMED" ? `${step.contact.statusLabel.toLowerCase()}${step.contact.sourceLabel ? ` via ${step.contact.sourceLabel.toLowerCase()}` : ""}` : "not confirmed for this order",
      at: step.contact.confirmedAt, tone: step.contact.tone,
    })
    if (step.access && !step.recorded) facts.push({
      label: "Access", value: step.access.statusLabel,
      certainty: step.access.status === "CONFIRMED" ? (orderSpecific(step.access.source) ? "confirmed" : "stated") : "missing",
      source: step.access.source === "MANAGED_SITE_PROFILE" ? "standard site profile, not a call about this car" : step.access.sourceLabel ? step.access.sourceLabel.toLowerCase() : "no confirmation recorded",
      at: step.access.confirmedAt, tone: step.access.tone,
    })
    for (const claim of step.claims.filter((entry) => entry.status === "OPEN")) facts.push({ label: `Claim: ${claim.field.toLowerCase()}`, value: claim.claim, certainty: "stated", source: `${claim.source ?? "unattributed"}, not resolved`, at: claim.recordedAt, tone: "warn" })
    groups.push({ title, icon, rows: facts })
  }

  const driverFacts: FactRow[] = []
  for (const assignment of view.assignments.filter((entry) => entry.status !== "CANCELLED")) {
    driverFacts.push({ label: "Driver", value: assignment.driver.name, certainty: "confirmed", source: `booking ${assignment.statusLabel.toLowerCase()}, accepted`, at: assignment.acceptedAt, tone: assignment.tone })
    if (assignment.positioning) driverFacts.push({ label: "Getting there", value: assignment.positioning, certainty: "planned", source: "estimate; a home base or prior job is not a location", at: null, tone: "neutral" })
  }
  const leg = first?.legs.find((entry) => entry.tracking)
  if (leg?.tracking) driverFacts.push({ label: "Last position", value: `${leg.tracking.eta ? `ETA ${fmtDateTime(leg.tracking.eta)}` : "no ETA"}${leg.tracking.remainingKm != null ? ` · ${leg.tracking.remainingKm} km left` : ""}`, certainty: "stated", source: `driver app, ${leg.tracking.qualityLabel.toLowerCase()} signal`, at: leg.tracking.receivedAt, tone: "neutral" })
  if (!view.assignments.length) {
    const offer = view.offers.find((entry) => entry.status === "PUBLISHED")
    driverFacts.push(offer
      ? { label: "Driver", value: `Offer live${offer.fee ? ` at ${offer.fee}` : ""}`, certainty: "planned", source: "published to drivers; nobody has accepted", at: offer.publishedAt, tone: "accent" }
      : { label: "Driver", value: "Not booked", certainty: "missing", source: "no offer published yet", at: null, tone: "neutral" })
  }
  groups.push({ title: "Driver", icon: "driver", rows: driverFacts })

  const travel: FactRow[] = [
    ...view.reservations.map((entry): FactRow => ({ label: entry.kindLabel, value: `${entry.route ?? entry.kindLabel}${entry.departureAt ? `, ${fmtDateTime(entry.departureAt)}` : ""}`, certainty: entry.status === "BOOKED" ? "confirmed" : "missing", source: `${entry.statusLabel.toLowerCase()}${entry.reference ? ` · ref ${entry.reference}` : ""}; a booking is not a boarding`, at: entry.bookedAt, tone: entry.tone })),
    ...view.options.map((entry): FactRow => ({ label: `${entry.kindLabel} option`, value: `${entry.provider ?? entry.route ?? ""}${entry.departureAt ? `, ${fmtDateTime(entry.departureAt)}` : ""}${entry.quote ? ` · ${entry.quote}` : ""}`, certainty: "quoted", source: `${entry.statusLabel.toLowerCase()} when checked; a quote is not a booking`, at: entry.checkedAt, tone: entry.tone })),
  ]
  if (travel.length) groups.push({ title: "Travel", icon: "ferry", rows: travel })

  const papers: FactRow[] = [
    ...view.documents.map((entry): FactRow => ({ label: entry.kindLabel, value: entry.statusLabel, certainty: entry.status === "VERIFIED" || entry.status === "SIGNED" ? "confirmed" : entry.status === "MISSING" ? "missing" : "stated", source: entry.signatureScope === "COLLECTION_ONLY" ? "signed at collection only, not by the receiver" : entry.medium ? `${entry.medium.toLowerCase()} document` : "document record", at: entry.updatedAt, tone: entry.tone })),
    ...view.custody.assets.map((asset): FactRow => ({ label: asset.kindLabel, value: `Holder: ${asset.holder}`, certainty: "stated", source: asset.basis, at: null, tone: asset.nextAction ? "warn" : "neutral" })),
  ]
  if (papers.length) groups.push({ title: "Papers and keys", icon: "key", rows: papers })
  return groups
}

function buildTimeline(view: RecordView, decisions: DecisionRecord[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const thread of view.threads) for (const message of thread.messages) entries.push({
    id: message.id, at: message.at, kind: "message", actor: message.author, title: thread.categoryLabel, body: message.body,
    meta: `${message.channelLabel} to ${message.recipient.name}`, internal: message.internal, tone: "neutral",
  })
  for (const day of view.history) for (const event of day.events) entries.push({
    id: event.id, at: event.at, kind: "event", actor: event.actor ? { id: null, kind: "operator", name: event.actor, role: null } : SYSTEM,
    title: event.text, body: null, meta: event.detail, internal: false, tone: "neutral",
  })
  for (const proposal of view.proposals) {
    entries.push({ id: `${proposal.id}-p`, at: proposal.createdAt, kind: "proposal", actor: proposal.agent, title: `Proposed: ${proposal.summary}`, body: proposal.rationale, meta: proposal.commandLabel, internal: true, tone: "accent" })
    if (proposal.review) entries.push({ id: `${proposal.id}-r`, at: proposal.review.at, kind: "review", actor: proposal.review.reviewer, title: `${proposal.review.decisionLabel} the agent's proposal`, body: proposal.review.note, meta: proposal.summary, internal: true, tone: "neutral" })
    if (proposal.execution?.at) entries.push({ id: `${proposal.id}-x`, at: proposal.execution.at, kind: "proposal", actor: proposal.agent, title: proposal.execution.error ? "Action failed" : `Action ${proposal.execution.statusLabel.toLowerCase()}`, body: proposal.execution.error, meta: proposal.summary, internal: true, tone: proposal.execution.error ? "danger" : "ok" })
  }
  for (const note of view.notifications) entries.push({ id: note.id, at: note.at, kind: "room", actor: note.actor, title: `${note.activityLabel} in ${note.destination}`, body: note.preview, meta: null, internal: true, tone: "neutral" })
  for (const note of view.notes) entries.push({ id: note.id, at: note.at, kind: "note", actor: note.author, title: "Note", body: note.body, meta: null, internal: true, tone: "neutral" })
  for (const decision of decisions) entries.push({
    id: decision.id, at: decision.decidedAt, kind: "decision", actor: { id: null, kind: "operator", name: "You", role: "control room" },
    title: `${ACTION_LABELS[decision.action]}`, body: decision.note, meta: decision.effects.map((effect) => effect.text).join(" "), internal: true, tone: "ok",
  })
  return entries.sort((a, b) => b.at.localeCompare(a.at))
}

export function buildCaseView(bundle: Bundle, view: RecordView, decisions: DecisionRecord[]): CaseView {
  const { open, decided } = applyDecisions(deriveAttention(bundle), decisions)
  return {
    open: sortAttention(open).map((item) => caseItem(item, bundle, new Set(decided.map(({ decision }) => decision.targetId)))),
    decided: decided.map(({ item, decision }) => ({ item, decision, actionLabel: ACTION_LABELS[decision.action] })),
    facts: buildFacts(view),
    timeline: buildTimeline(view, decisions),
  }
}

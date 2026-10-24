// What needs a person on an order. Each item says why, what the next step is
// and where that step came from, which clock decides it, and who owns it.
import type { ActionKind, Decision, InboxThread, Proposal } from './types';
import type { OrderBundle, World } from './world';
import { deriveStage, isAlertOpen, pickupUnverified } from './evidence';
import {
  EXTERNAL_WAITS, categoryLabel, incidentLabel, incidentStatusLabel, partyLabel, signalLabel, waitingOnLabel, workKindLabel,
} from './labels';
import { chooseNextStep, type NextStep } from './nextStep';
import { payloadSteps } from './proposals';
import { formatShort, isPast, minutesBetween } from './clock';

export type ItemKind =
  | 'proposal' | 'alert' | 'incident' | 'work_item' | 'conversation' | 'claim' | 'custody'
  | 'inbox_candidate' | 'inbox' | 'pickup_check' | 'silent_driver';

export type Group = 'decide' | 'follow' | 'waiting';
export const GROUP_ORDER: Group[] = ['decide', 'follow', 'waiting'];

/** 0 low, 1 medium, 2 high, 3 critical. */
export type Risk = 0 | 1 | 2 | 3;

export interface Clock {
  at: string;
  /** What the time is: "due", "next check", "pickup", "promise ends". */
  what: string;
}

export interface AttentionItem {
  /** The id a decision is recorded against. */
  id: string;
  orderId: string;
  kind: ItemKind;
  /** The record behind the item, for "where did this come from". */
  source: { table: string; id: string };
  /** One plain reason line. */
  title: string;
  /** The record's own words, if it has a summary worth reading. */
  detail: string | null;
  status: string | null;
  risk: Risk;
  clock: Clock | null;
  owner: string | null;
  waitingOn: string | null;
  group: Group;
  next: NextStep;
  actions: ActionKind[];
  proposal?: Proposal;
  thread?: InboxThread;
  raisedAt: string | null;
  /** A live decision made in this app, if any. Decided items leave the queue. */
  decision?: Decision;
}

/** How far ahead of a pickup slot an unchecked contact or access becomes a follow-up. */
export const PICKUP_CHECK_HOURS = 72;

/** A high-risk item whose clock falls within this window needs a decision now. */
export const DECIDE_WITHIN_MINUTES = 240;

const SEVERITY: Record<string, Risk> = { low: 0, medium: 1, high: 2, critical: 3 };

/** The clock that decides an order: the pickup slot until the car is collected, then the delivery promise. */
export function decidingClock(b: OrderBundle, now: string): Clock | null {
  const stage = deriveStage(b);
  if (stage === 'cancelled' || stage === 'delivered') return null;
  const collected = b.steps.some((s) => s.kind === 'VEHICLE_PICKUP' && s.status === 'COMPLETED') || stage === 'moving';
  if (!collected) {
    const slot = b.windows.find((w) => w.purpose === 'SELECTED_PICKUP_SLOT' && w.is_selected);
    if (slot) return { at: slot.start_at, what: isPast(slot.end_at, now) ? 'pickup slot passed' : 'pickup' };
  }
  const promise = b.windows.find((w) => w.purpose === 'CUSTOMER_DELIVERY_PROMISE' && w.is_selected)
    ?? b.windows.find((w) => w.purpose === 'CUSTOMER_DELIVERY_PROMISE');
  // A booked crossing still ahead decides earlier than the promise: miss check-in and the promise goes too.
  const ferry = b.reservations.find((r) => r.kind === 'FERRY' && r.status === 'BOOKED' && !r.cancelled_at
    && r.check_in_cutoff_at && !isPast(r.check_in_cutoff_at, now) && (!promise || r.check_in_cutoff_at < promise.end_at));
  if (ferry?.check_in_cutoff_at) return { at: ferry.check_in_cutoff_at, what: 'ferry check-in closes' };
  if (promise) return { at: promise.end_at, what: 'promise ends' };
  return null;
}

function agentTitle(world: World, id: string) {
  return world.agents.get(id)?.title ?? 'Agent';
}

function lower(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "Agent proposes: keeps collection on hold, asks the site… (+2 more)". */
export function proposalNextLine(p: Proposal, world: World): string {
  const steps = payloadSteps(p, world);
  if (p.status === 'FAILED') return `The ${lower(agentTitle(world, p.proposed_by_agent_id))}’s attempt failed. Decide who takes it.`;
  if (p.status === 'APPROVED_AWAITING_EXECUTION') return `Approved; the ${lower(agentTitle(world, p.proposed_by_agent_id))} still has to act.`;
  const shown = steps.slice(0, 2).map((s) => lower(s.text.replace(/\.$/, '')));
  const more = steps.length > 2 ? ` (+${steps.length - 2} more)` : '';
  return `Agent proposes: ${shown.join('; ')}${more}.`;
}

function riskGroup(risk: Risk, clock: Clock | null, now: string): Group {
  if (risk >= 3) return 'decide';
  if (risk === 2 && (!clock || minutesBetween(now, clock.at) <= DECIDE_WITHIN_MINUTES)) return 'decide';
  return 'follow';
}

/** Every attention item on one order, before decisions are applied. */
export function orderItems(b: OrderBundle, world: World): AttentionItem[] {
  const now = world.snapshotAt;
  const oid = b.order.id;
  const stage = deriveStage(b);
  const items: AttentionItem[] = [];
  const deciding = decidingClock(b, now);

  const liveProposals = b.proposals.filter((p) => ['PENDING_REVIEW', 'APPROVED_AWAITING_EXECUTION', 'FAILED'].includes(p.status));
  const waitingProposal = liveProposals.find((p) => p.status === 'PENDING_REVIEW') ?? liveProposals.find((p) => p.status === 'FAILED');
  const agentLine = waitingProposal ? `Decide on the ${lower(agentTitle(world, waitingProposal.proposed_by_agent_id))}’s proposal.` : null;
  const alertById = new Map(b.alerts.map((a) => [a.id, a]));

  // Agent proposals.
  for (const p of liveProposals) {
    const alert = p.alert_id ? alertById.get(p.alert_id) : undefined;
    const risk = Math.max(1, alert ? SEVERITY[alert.severity] ?? 1 : 2) as Risk;
    const pending = p.status === 'PENDING_REVIEW';
    const failed = p.status === 'FAILED';
    items.push({
      id: p.id, orderId: oid, kind: 'proposal', source: { table: 'agent_proposals', id: p.id },
      title: failed ? `${agentTitle(world, p.proposed_by_agent_id)}: attempt failed` : pending
        ? `${agentTitle(world, p.proposed_by_agent_id)} needs your yes`
        : `${agentTitle(world, p.proposed_by_agent_id)}: approved, not done yet`,
      detail: failed ? p.execution?.error ?? null : p.rationale,
      status: p.status, risk, clock: deciding, owner: alert?.owner ?? p.review?.reviewer_id ?? null, waitingOn: pending || failed ? null : 'agent',
      group: pending || failed ? 'decide' : 'waiting',
      next: { text: proposalNextLine(p, world), source: 'agent' },
      actions: pending ? ['approve', 'change', 'reject'] : failed ? ['retry', 'take', 'already_sorted'] : ['take', 'done'],
      proposal: p, raisedAt: p.created_at,
    });
  }

  // Alerts that are open or only acknowledged. Acknowledged is not resolved.
  for (const a of b.alerts.filter(isAlertOpen)) {
    const risk = SEVERITY[a.severity] ?? 1;
    items.push({
      id: a.id, orderId: oid, kind: 'alert', source: { table: 'alerts', id: a.id },
      title: signalLabel(a.signal), detail: a.summary,
      status: a.status, risk, clock: deciding, owner: a.owner ?? null, waitingOn: null,
      group: riskGroup(risk, deciding, now),
      next: chooseNextStep(a.next_action, agentLine, `alert:${a.signal}`),
      actions: ['take', 'done'], raisedAt: a.triggered_at,
    });
  }

  // Incidents not yet resolved.
  for (const i of b.incidents.filter((x) => !x.resolved_at)) {
    const risk: Risk = i.status === 'NEEDS_HUMAN' || i.status === 'AWAITING_DECISION' ? 2 : 1;
    items.push({
      id: i.id, orderId: oid, kind: 'incident', source: { table: 'incidents', id: i.id },
      title: `${incidentLabel(i.kind)}, ${incidentStatusLabel(i.status)}`,
      detail: [i.reported_symptom, i.reported_stop_text].filter(Boolean).join('. ') || null,
      status: i.status, risk, clock: deciding, owner: i.owner, waitingOn: null,
      group: riskGroup(risk, deciding, now),
      next: chooseNextStep(null, agentLine, `incident:${i.kind}`),
      actions: ['take', 'done'], raisedAt: i.opened_at,
    });
  }

  // Open work items: they carry their own next action and due time.
  for (const w of b.workItems.filter((x) => x.status !== 'DONE' && !x.closed_at)) {
    const risk: Risk = w.priority === 'high' ? 2 : 1;
    const clock = w.due_at ? { at: w.due_at, what: 'due' } : null;
    items.push({
      id: w.id, orderId: oid, kind: 'work_item', source: { table: 'work_items', id: w.id },
      title: workKindLabel(w.kind), detail: w.summary,
      status: w.status, risk, clock, owner: w.owner, waitingOn: null,
      group: riskGroup(risk, clock, now),
      next: chooseNextStep(w.next_action, agentLine, 'work_item'),
      actions: ['take', 'done'], raisedAt: w.opened_at,
    });
  }

  // Open conversations, including ones filed on another order that name this one.
  for (const c of b.conversations.filter((x) => x.status === 'OPEN')) {
    const latest = b.messages.filter((m) => m.conversation_id === c.id && m.visibility === 'PUBLIC').at(-1);
    const external = !!c.waiting_on && EXTERNAL_WAITS.has(c.waiting_on);
    const clock = c.next_check_at ? { at: c.next_check_at, what: 'next check' } : null;
    const filedElsewhere = c.order_id !== oid;
    const recordWait = c.waiting_on
      ? `Waiting on ${waitingOnLabel(c.waiting_on)}${c.next_check_at ? `. Check again at ${formatShort(c.next_check_at, now)}` : ''}.`
      : null;
    items.push({
      id: c.id, orderId: oid, kind: 'conversation', source: { table: 'conversations', id: c.id },
      title: `${c.counterparty_type ? `Open thread with the ${partyLabel(c.counterparty_type)}` : 'Open case thread'} about ${categoryLabel(c.category)}${filedElsewhere ? ` (filed on ${world.bundles.get(c.order_id)?.order.reference ?? 'another order'})` : ''}`,
      detail: latest ? latest.body : null,
      status: c.status, risk: external ? 1 : 0, clock, owner: c.owner ?? null, waitingOn: c.waiting_on ?? null,
      group: external && clock && !isPast(clock.at, now) ? 'waiting' : 'follow',
      next: chooseNextStep(recordWait, agentLine, 'conversation'),
      actions: ['take', 'done'], raisedAt: latest?.authored_at ?? c.updated_at,
    });
  }

  // Endpoint claims nobody has resolved.
  for (const cl of b.claims.filter((x) => !x.resolved_at)) {
    items.push({
      id: cl.id, orderId: oid, kind: 'claim', source: { table: 'endpoint_claims', id: cl.id },
      title: `Unresolved statement about the ${cl.field.replace(/_/g, ' ')}`, detail: cl.claim,
      status: cl.resolution_status, risk: 1, clock: deciding, owner: null, waitingOn: null, group: 'follow',
      next: chooseNextStep(null, agentLine, 'claim'), actions: ['take', 'done'], raisedAt: cl.recorded_at,
    });
  }

  // Keys and papers with an owned next check.
  for (const k of b.custody.filter((x) => x.next_action && !x.physical_handover_verified_at)) {
    const clock = k.followup_due_at ? { at: k.followup_due_at, what: 'due' } : null;
    items.push({
      id: k.id, orderId: oid, kind: 'custody', source: { table: 'custody_assets', id: k.id },
      title: k.kind === 'KEY_SET' ? 'Who holds the keys is unknown' : 'Custody unknown', detail: k.label,
      status: k.status, risk: 1, clock, owner: k.followup_owner, waitingOn: null, group: 'follow',
      next: chooseNextStep(k.next_action, agentLine, 'custody'), actions: ['take', 'done'], raisedAt: null,
    });
  }

  // Support inbox threads already linked to this order and still open.
  for (const t of world.inboxThreads.filter((x) => x.status === 'OPEN' && (x.linked_order_ids ?? []).includes(oid))) {
    const external = !!t.waiting_on && EXTERNAL_WAITS.has(t.waiting_on);
    items.push({
      id: t.id, orderId: oid, kind: 'inbox', source: { table: 'support_inbox_threads', id: t.id },
      title: `Support message from the ${partyLabel(t.counterparty_type)} about ${categoryLabel(t.category)}`,
      detail: world.inboxMessages.get(t.id)?.find((m) => m.author_type !== 'operator')?.body ?? null,
      status: t.status, risk: 0, clock: null, owner: t.owner, waitingOn: t.waiting_on,
      group: external ? 'waiting' : 'follow',
      next: chooseNextStep(t.waiting_on ? `Waiting on ${waitingOnLabel(t.waiting_on)}.` : null, null, 'inbox:linked'),
      actions: ['take', 'done'], thread: t, raisedAt: t.opened_at,
    });
  }

  // Unmatched inbox messages that might be about this order. Candidates are guesses.
  for (const t of world.inboxThreads.filter((x) => x.status === 'OPEN' && (x.linked_order_ids ?? []).length === 0 && (x.candidate_order_ids ?? []).includes(oid))) {
    items.push({
      id: `${t.id}#${oid}`, orderId: oid, kind: 'inbox_candidate', source: { table: 'support_inbox_threads', id: t.id },
      title: 'An unmatched message may be about this order',
      detail: world.inboxMessages.get(t.id)?.find((m) => m.author_type !== 'operator')?.body ?? null,
      status: t.link_state, risk: 1, clock: deciding, owner: t.owner, waitingOn: null, group: 'follow',
      next: chooseNextStep(null, null, 'inbox'), actions: ['link', 'not_this'], thread: t, raisedAt: t.opened_at,
    });
  }

  // Derived: a booked car whose pickup contact or access nobody has checked for this order.
  if (stage === 'booked') {
    const ep = b.endpoints.find((e) => e.boundary === 'PICKUP');
    const slot = b.windows.find((w) => w.purpose === 'SELECTED_PICKUP_SLOT' && w.is_selected);
    // A check is due when the slot is near, not for every booking with a gap (dataset README).
    const dueSoon = slot && !isPast(slot.end_at, now) && minutesBetween(now, slot.start_at) <= PICKUP_CHECK_HOURS * 60;
    if (ep && slot && dueSoon && pickupUnverified(ep)) {
      const soon = minutesBetween(now, slot.start_at) <= 24 * 60;
      items.push({
        id: `derived:pickup-check:${oid}`, orderId: oid, kind: 'pickup_check', source: { table: 'order_endpoint_details', id: ep.id },
        title: 'Driver booked, but the pickup contact or access isn’t checked', detail: null,
        status: null, risk: soon ? 1 : 0, clock: { at: slot.start_at, what: 'pickup' }, owner: null, waitingOn: null, group: 'follow',
        next: chooseNextStep(null, agentLine, 'pickup_check'), actions: ['take', 'done'], raisedAt: null,
      });
    }
  }

  // Derived: a moving car whose driver started but the app has sent no position, promise still open.
  if (stage === 'moving') {
    for (const a of b.assignments.filter((x) => x.status === 'IN_PROGRESS' && x.started_at)) {
      const positions = b.tracking.filter((t) => t.assignment_id === a.id);
      const promise = deciding && deciding.what === 'promise ends' && !isPast(deciding.at, now) ? deciding : null;
      if (positions.length === 0 && promise) {
        items.push({
          id: `derived:silent-driver:${oid}:${a.id}`, orderId: oid, kind: 'silent_driver', source: { table: 'work_assignments', id: a.id },
          title: 'Driver started, but the app has sent no position', detail: null,
          status: null, risk: 2, clock: promise, owner: null, waitingOn: null, group: riskGroup(2, promise, now),
          next: chooseNextStep(null, agentLine, 'silent_driver'), actions: ['take', 'done'], raisedAt: a.started_at,
        });
      }
    }
  }

  return items;
}

/** Applies the decisions people made: decided items carry their decision and leave the queue. */
export function applyDecisions(items: AttentionItem[], decisions: Decision[]): AttentionItem[] {
  const live = new Map(decisions.filter((d) => !d.undone_at).map((d) => [d.target_id, d]));
  const linkedThreads = new Map<string, Decision>();
  for (const d of live.values()) if (d.target_type === 'inbox_candidate' && d.action === 'link') linkedThreads.set(d.target_id.split('#')[0]!, d);
  return items.map((it) => {
    const own = live.get(it.id);
    if (own) return { ...it, decision: own };
    // Linking one candidate rules out the others.
    if (it.kind === 'inbox_candidate') {
      const link = linkedThreads.get(it.id.split('#')[0]!);
      if (link) return { ...it, decision: link };
    }
    return it;
  });
}

export const isOpen = (it: AttentionItem) => !it.decision;

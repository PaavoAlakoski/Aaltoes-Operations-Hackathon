// Everything the order page shows, derived in one place: header, headline,
// the lead decision, the other open items, the facts and the timeline.
import type { Decision } from './types';
import { deliveryPromise, otherPickupSlots, pickupSlot, type OrderBundle, type World } from './world';
import {
  accessFact, bookingFact, boardingFact, cmrFact, contactFact, deriveStage, positionFact, quoteFact, type Fact, type Stage,
} from './evidence';
import { decidingClock, isOpen, type AttentionItem, type Clock } from './attention';
import { leadItem, compareItems, situationItem } from './triage';
import {
  STAGE_LABEL, actorLabel, documentKindLabel, documentStatusLabel, eventLabel, proofKindLabel, proofStatusLabel, sourceLabel,
  ACTION_LABEL, signalLabel, capitalize,
} from './labels';
import { formatTime, relative } from './clock';

export interface CaseHeader {
  reference: string;
  car: string;
  route: string;
  customer: string;
  stage: Stage;
  stageLabel: string;
  deciding: Clock | null;
}

export interface FactSection {
  title: string;
  facts: Fact[];
}

export type Who = 'people' | 'agents' | 'drivers' | 'customers' | 'sites' | 'system';

export interface TimelineEntry {
  id: string;
  at: string;
  who: Who;
  actor: string;
  text: string;
  kind: 'message' | 'event' | 'agent' | 'decision' | 'room';
  internal: boolean;
}

export interface CaseView {
  header: CaseHeader;
  headline: string;
  lead: AttentionItem | null;
  others: AttentionItem[];
  decided: AttentionItem[];
  quiet: boolean;
  facts: FactSection[];
  timeline: TimelineEntry[];
}

export function carName(b: OrderBundle): string {
  const primary = b.items.find((i) => i.role === 'PRIMARY');
  const v = b.vehicles.find((x) => x.id === primary?.vehicle_id) ?? b.vehicles[0];
  if (!v || (!v.make && !v.model)) return 'Car not identified';
  return [v.make, v.model].filter(Boolean).join(' ');
}

export function routeLine(b: OrderBundle, world: World): string {
  const from = world.addresses.get(b.order.pickup_address_id);
  const to = world.addresses.get(b.order.delivery_address_id);
  return `${from?.city ?? 'Unknown'} → ${to?.city ?? 'Unknown'}`;
}

export function header(b: OrderBundle, world: World): CaseHeader {
  const stage = deriveStage(b);
  return {
    reference: b.order.reference,
    car: carName(b),
    route: routeLine(b, world),
    customer: world.customers.get(b.order.customer_id)?.name ?? 'Unknown customer',
    stage,
    stageLabel: STAGE_LABEL[stage],
    deciding: decidingClock(b, world.snapshotAt),
  };
}

// --- Facts -----------------------------------------------------------------

function facts(b: OrderBundle, world: World): FactSection[] {
  const now = world.snapshotAt;
  const stage = deriveStage(b);
  const sections: FactSection[] = [];

  // Car
  const car: Fact[] = [];
  const primaryFirst = b.items.slice().sort((x, y) => Number(x.role === 'TRADE_IN') - Number(y.role === 'TRADE_IN'));
  for (const item of primaryFirst) {
    const v = b.vehicles.find((x) => x.id === item.vehicle_id);
    const label = item.role === 'TRADE_IN' ? 'Trade-in' : 'Car';
    if (!v) continue;
    const ident = [v.registration, v.synthetic_vin && `VIN ${v.synthetic_vin}`].filter(Boolean).join(' · ');
    car.push({
      label, value: `${[v.make, v.model, v.model_year].filter(Boolean).join(' ') || 'Not identified'}${ident ? ` · ${ident}` : ''}`,
      certainty: ident ? 'stated' : 'missing', by: ident ? 'order intake' : null, at: ident ? b.order.created_at : null,
      note: ident ? undefined : 'No VIN or plate recorded',
    });
  }
  sections.push({ title: 'Car', facts: car });

  // Pickup
  const pickup: Fact[] = [];
  const pAddr = world.addresses.get(b.order.pickup_address_id);
  pickup.push(addressFact('Pickup at', pAddr, b));
  const pEp = b.endpoints.find((e) => e.boundary === 'PICKUP');
  if (pEp) pickup.push(accessFact(pEp), contactFact(pEp));
  const slot = pickupSlot(b);
  for (const other of otherPickupSlots(b)) {
    pickup.push({
      label: 'Trade-in pickup slot', value: `${formatTime(other.start_at, other.timezone)}–${formatTime(other.end_at, other.timezone).split(', ')[1]}`,
      certainty: 'planned', by: `selected by ${sourceLabel(other.source)}`, at: null,
    });
  }
  if (slot) {
    pickup.push({
      label: 'Pickup slot', value: `${formatTime(slot.start_at, slot.timezone)}–${formatTime(slot.end_at, slot.timezone).split(', ')[1]}`,
      certainty: 'planned', by: `selected by ${sourceLabel(slot.source)}`, at: null, note: slot.source === 'OPS' ? 'Our selection, not customer approval' : undefined,
    });
  }
  const pickedUp = b.steps.find((s) => s.kind === 'VEHICLE_PICKUP' && s.status === 'COMPLETED');
  const notFound = b.events.find((e) => e.command === 'pickup.attempted' && e.to_state === 'VEHICLE_NOT_FOUND');
  if (pickedUp) pickup.push({ label: 'Collected', value: 'Car collected', certainty: 'confirmed', by: 'driver app', at: pickedUp.completed_at });
  else if (notFound) pickup.push({ label: 'Collected', value: 'Driver went, car not found', certainty: 'stated', by: 'driver', at: notFound.recorded_at });
  else if (stage !== 'cancelled') {
    // Before the slot, an uncollected car is the plan, not a gap.
    const due = slot && Date.parse(slot.end_at) < Date.parse(now);
    pickup.push(due || !slot
      ? { label: 'Collected', value: 'No collection recorded', certainty: 'missing', by: null, at: null, note: slot ? 'The slot has passed' : undefined }
      : { label: 'Collected', value: 'Not yet, pickup is planned', certainty: 'planned', by: 'pickup slot', at: null });
  }
  sections.push({ title: 'Pickup', facts: pickup });

  // Driver and travel
  const travel: Fact[] = [];
  const live = b.assignments.filter((a) => a.status === 'ASSIGNED' || a.status === 'IN_PROGRESS');
  for (const a of live) {
    travel.push({
      label: 'Driver', value: world.drivers.get(a.driver_id)?.display_name ?? 'Booked driver', certainty: 'confirmed', by: 'booking record',
      at: a.accepted_at, note: a.status === 'ASSIGNED' ? 'Booked, not yet started' : undefined,
    });
  }
  if (!live.length && stage !== 'delivered' && stage !== 'cancelled') {
    const offered = b.offers.find((o) => o.status === 'PUBLISHED');
    travel.push(offered
      ? { label: 'Driver', value: 'Offered to drivers, nobody has taken it', certainty: 'planned', by: 'driver market', at: offered.published_at }
      : { label: 'Driver', value: 'No driver booked', certainty: 'missing', by: null, at: null });
  }
  for (const r of b.reservations.filter((x) => !x.cancelled_at && x.status !== 'CANCELLED')) {
    travel.push(bookingFact(r));
    const boarding = boardingFact(r);
    if (boarding && (stage === 'moving' || stage === 'booked')) travel.push(boarding);
  }
  // Only quotes from the last day still describe what can be had.
  for (const o of b.options.filter((x) => Date.parse(now) - Date.parse(x.checked_at) < 24 * 3600_000)) travel.push(quoteFact(o));
  if (stage === 'moving') {
    const pos = positionFact(b.tracking.at(-1), true);
    if (pos) travel.push(pos);
  }
  if (travel.length) sections.push({ title: 'Driver and travel', facts: travel });

  // Delivery
  const delivery: Fact[] = [];
  delivery.push(addressFact('Deliver to', world.addresses.get(b.order.delivery_address_id), b));
  const dEp = b.endpoints.find((e) => e.boundary === 'DELIVERY');
  if (dEp && stage !== 'delivered') delivery.push(accessFact(dEp), contactFact(dEp));
  const promise = deliveryPromise(b);
  if (promise) {
    delivery.push({
      label: 'Delivery promise', value: `${formatTime(promise.start_at, promise.timezone)}–${formatTime(promise.end_at, promise.timezone).split(', ')[1]}`,
      certainty: 'planned', by: sourceLabel(promise.source), at: null,
    });
    if (promise.commitment_deadline_at) {
      delivery.push({ label: 'Latest agreed', value: formatTime(promise.commitment_deadline_at, promise.timezone), certainty: 'stated', by: sourceLabel(promise.deadline_source), at: null });
    }
  }
  const delivered = b.events.find((e) => e.command === 'vehicle.delivered');
  if (delivered) delivery.push({ label: 'Delivered', value: 'Car handed over', certainty: 'confirmed', by: actorLabel(delivered.actor_type).toLowerCase(), at: delivered.recorded_at });
  for (const d of b.documents) {
    if (d.kind === 'CMR') delivery.push(cmrFact(d));
    else delivery.push({
      label: documentKindLabel(d.kind), value: capitalize(documentStatusLabel(d.status)),
      certainty: d.status === 'VERIFIED' || d.status === 'SIGNED' ? 'confirmed' : d.status === 'MISSING' ? 'missing' : 'planned',
      by: 'document record', at: d.updated_at,
    });
  }
  for (const p of b.proofs.filter((x) => x.status === 'REJECTED' || x.status === 'REQUIRED' || x.status === 'SUBMITTED')) {
    delivery.push({
      label: proofKindLabel(p.kind), value: capitalize(proofStatusLabel(p.status)) + (p.review_note ? `: ${p.review_note}` : ''),
      certainty: p.status === 'REQUIRED' ? 'missing' : 'stated', by: p.status === 'REJECTED' ? 'reviewer' : 'driver', at: p.reviewed_at ?? p.submitted_at ?? null,
    });
  }
  for (const k of b.custody) {
    delivery.push({ label: 'Keys', value: k.holder_role === 'UNKNOWN' ? 'Holder unknown, no handover evidence' : k.holder_role, certainty: 'missing', by: null, at: null });
  }
  sections.push({ title: 'Delivery', facts: delivery });
  return sections;
}

function addressFact(label: string, a: ReturnType<World['addresses']['get']>, b: OrderBundle): Fact {
  if (!a) return { label, value: 'No address', certainty: 'missing', by: null, at: null };
  const place = [a.name, a.address_line1, a.city].filter(Boolean).join(', ');
  if (!a.address_line1) return { label, value: `${a.city ?? 'Unknown city'}, no street address`, certainty: 'missing', by: null, at: null };
  return { label, value: place, certainty: 'stated', by: a.managed_site_id ? 'site profile' : 'customer, on the order', at: b.order.created_at };
}

// --- Timeline ---------------------------------------------------------------

const WHO: Record<string, Who> = {
  operator: 'people', agent: 'agents', driver: 'drivers', customer: 'customers',
  site_contact: 'sites', handoff_contact: 'sites', system: 'system',
};

export const WHO_LABEL: Record<Who, string> = {
  people: 'People', agents: 'Agents', drivers: 'Drivers', customers: 'Customers', sites: 'Sites and contacts', system: 'System',
};

function timeline(b: OrderBundle, world: World, decisions: Decision[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const operatorName = (id: string | null) => (id && world.operators.get(id)?.title) || 'Operations';
  const agentName = (id: string) => world.agents.get(id)?.title ?? 'Agent';

  for (const m of b.messages) {
    const who = WHO[m.author_type] ?? 'system';
    const actor = m.author_name_snapshot
      ?? (m.author_type === 'operator' ? operatorName(m.author_id)
        : m.author_type === 'driver' ? world.drivers.get(m.author_id ?? '')?.display_name ?? 'Driver'
          : m.author_type === 'customer' ? world.customers.get(m.author_id ?? '')?.name ?? 'Customer'
            : m.author_type === 'agent' ? agentName(m.author_id ?? '') : actorLabel(m.author_type));
    out.push({ id: m.id, at: m.authored_at, who, actor, text: m.body, kind: 'message', internal: m.visibility === 'INTERNAL' });
  }
  for (const e of b.events) {
    const who = WHO[e.actor_type] ?? 'system';
    const actor = e.actor_type === 'operator' ? operatorName(e.actor_id) : e.actor_type === 'agent' ? agentName(e.actor_id ?? '')
      : e.actor_type === 'driver' ? world.drivers.get(e.actor_id ?? '')?.display_name ?? 'Driver' : actorLabel(e.actor_type);
    const signal = typeof e.changes?.signal === 'string' ? `: ${signalLabel(e.changes.signal).toLowerCase()}` : '';
    out.push({ id: e.id, at: e.recorded_at, who, actor, text: `${eventLabel(e.command)}${signal}`, kind: 'event', internal: false });
  }
  for (const p of b.proposals) {
    out.push({ id: `${p.id}:proposed`, at: p.created_at, who: 'agents', actor: agentName(p.proposed_by_agent_id), text: `Proposed: ${p.summary}`, kind: 'agent', internal: true });
    if (p.review) {
      const verb = p.review.decision === 'APPROVED' ? 'Approved' : p.review.decision === 'EDITED' ? 'Changed' : 'Rejected';
      out.push({ id: `${p.id}:review`, at: p.review.reviewed_at, who: 'people', actor: operatorName(p.review.reviewer_id), text: `${verb} the proposal: ${p.review.decision_note}`, kind: 'agent', internal: true });
    }
    if (p.execution) {
      const ok = p.execution.status === 'SUCCEEDED' && p.execution.effect_event_ids.length > 0;
      out.push({
        id: `${p.id}:exec`, at: p.execution.attempted_at, who: 'agents', actor: agentName(p.proposed_by_agent_id),
        text: ok ? 'Carried out the approved proposal; the change is recorded.' : `Attempt failed: ${p.execution.error ?? 'no change recorded'}`,
        kind: 'agent', internal: true,
      });
    }
  }
  for (const n of b.notifications) {
    const isAgent = !!n.actor_id && world.agents.has(n.actor_id);
    out.push({
      id: n.id, at: n.occurred_at, who: isAgent ? 'agents' : n.actor_id ? 'people' : 'system',
      actor: isAgent ? agentName(n.actor_id!) : n.actor_id ? operatorName(n.actor_id) : 'Alert room', text: n.preview, kind: 'room', internal: true,
    });
  }
  for (const d of decisions.filter((x) => x.order_id === b.order.id)) {
    out.push({
      id: d.id, at: d.decided_at, who: 'people', actor: 'You',
      text: `${ACTION_LABEL[d.action]}${d.note ? `: ${d.note}` : ''}${d.undone_at ? ' (undone)' : ''}`, kind: 'decision', internal: true,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// --- Headline -------------------------------------------------------------

function headline(b: OrderBundle, world: World, lead: AttentionItem | null, open: AttentionItem[]): string {
  const stage = deriveStage(b);
  if (!lead) {
    if (stage === 'cancelled') return 'Cancelled. Nothing is open.';
    if (stage === 'delivered') return 'Delivered. Nothing is open on this order.';
    return `${STAGE_LABEL[stage]}. Nothing is open; that is not the same as verified.`;
  }
  const situation = situationItem(open) ?? lead;
  const proposal = open.find((i) => i.kind === 'proposal' && i.group === 'decide');
  const first = `${situation.title.replace(/\.$/, '')}.`;
  const context = stageContext(b, world);
  if (proposal && proposal !== situation) {
    const agent = world.agents.get(proposal.proposal!.proposed_by_agent_id)?.title ?? 'An agent';
    return proposal.status === 'FAILED' ? `${first} The ${agent.toLowerCase()}’s attempt failed.` : `${first} The ${agent.toLowerCase()} has a proposal for you.`;
  }
  return context ? `${first} ${context}` : first;
}

/** One clause of where the order stands, so the headline says more than the lead's title. */
function stageContext(b: OrderBundle, world: World): string | null {
  const now = world.snapshotAt;
  const stage = deriveStage(b);
  if (stage === 'delivered') {
    const d = b.events.filter((e) => e.command === 'vehicle.delivered').at(-1);
    return d ? `Delivered ${relative(d.recorded_at, now)}.` : 'Delivered.';
  }
  const clock = decidingClock(b, now);
  if (!clock) return null;
  const when = relative(clock.at, now);
  const past = Date.parse(clock.at) < Date.parse(now);
  switch (clock.what) {
    case 'pickup': return past ? `Pickup was due ${when}.` : `Pickup ${when}.`;
    case 'pickup slot passed': return `The pickup slot started ${when}.`;
    case 'promise ends': return past ? `The delivery promise ended ${when}.` : `The delivery promise ends ${when}.`;
    case 'ferry check-in closes': return `Ferry check-in closes ${when}.`;
    default: return null;
  }
}

export function caseView(b: OrderBundle, world: World, items: AttentionItem[], decisions: Decision[]): CaseView {
  const open = items.filter(isOpen);
  const lead = leadItem(open) ?? null;
  return {
    header: header(b, world),
    headline: headline(b, world, lead, open),
    lead,
    others: open.filter((i) => i !== lead).sort(compareItems),
    decided: items.filter((i) => !isOpen(i)),
    quiet: open.length === 0,
    facts: facts(b, world),
    timeline: timeline(b, world, decisions),
  };
}

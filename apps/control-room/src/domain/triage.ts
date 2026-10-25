// Ranks the orders that need a person into three groups. Within a group,
// risk comes first, then the clock that decides the next step.
import type { Decision } from './types';
import type { OrderBundle, World } from './world';
import type { NextStep } from './nextStep';
import { GROUP_ORDER, applyDecisions, isOpen, orderItems, type AttentionItem, type Clock, type Group, type Risk } from './attention';

export interface QueueRow {
  orderId: string;
  reference: string;
  bundle: OrderBundle;
  group: Group;
  risk: Risk;
  clock: Clock | null;
  lead: AttentionItem;
  /** What is going on, in one line: the most urgent item that is not a proposal. */
  reason: string;
  /** The row's next step: the lead's, unless another open item has a recorded one and the lead only has a playbook line. */
  next: NextStep;
  /** Open items only. */
  items: AttentionItem[];
  owner: string | null;
}

export interface Triage {
  rows: QueueRow[];
  byGroup: Record<Group, QueueRow[]>;
  /** Orders with nothing open. Quiet is not the same as verified. */
  quiet: OrderBundle[];
  /** Every item on every order, with decisions applied. */
  allItems: Map<string, AttentionItem[]>;
}

/** Needs action shows at most this many orders, most urgent first; the rest stay under All orders. */
export const NEEDS_YOU_LIMIT = 9;

const groupRank = (g: Group) => GROUP_ORDER.indexOf(g);
const clockMs = (c: Clock | null) => (c ? Date.parse(c.at) : Number.POSITIVE_INFINITY);

/** Most urgent first: group, then risk, then the earliest clock. */
export function compareItems(a: AttentionItem, b: AttentionItem): number {
  return groupRank(a.group) - groupRank(b.group) || b.risk - a.risk || clockMs(a.clock) - clockMs(b.clock);
}

/** The one item the order page leads with: a proposal waiting on a person, else the most urgent item. */
export function leadItem(items: AttentionItem[]): AttentionItem | undefined {
  const open = items.filter(isOpen);
  // A pending proposal leads over a failed one: it is usually the agent's answer to the failure.
  const waiting = open.filter((i) => i.kind === 'proposal' && i.group === 'decide');
  const rank = (i: AttentionItem) => (i.status === 'PENDING_REVIEW' ? 0 : 1);
  if (waiting.length) return waiting.slice().sort((a, b) => rank(a) - rank(b) || (b.raisedAt ?? '').localeCompare(a.raisedAt ?? ''))[0];
  const sorted = open.slice().sort(compareItems);
  const top = sorted[0];
  // A signal with only a playbook line is not a decision. If an item of about the
  // same urgency carries a recorded next step, that item is the decision to lead with.
  if (top && top.next.source === 'playbook') {
    const recorded = sorted.find((i) => i.group === top.group && i.risk >= top.risk - 1 && i.next.source === 'record' && i.kind !== 'conversation');
    if (recorded) return recorded;
  }
  return top;
}

/** The situation on an order: the most urgent item that is not an agent proposal. */
export function situationItem(open: AttentionItem[]): AttentionItem | undefined {
  return open.filter((i) => i.kind !== 'proposal').sort(compareItems)[0] ?? open.slice().sort(compareItems)[0];
}

/** Prefer a recorded next step over a playbook line for the same order. */
export function rowNextStep(lead: AttentionItem, open: AttentionItem[]): NextStep {
  if (lead.next.source !== 'playbook') return lead.next;
  const recorded = open.filter((i) => i !== lead && i.next.source === 'record' && i.kind !== 'conversation').sort(compareItems)[0];
  return recorded?.next ?? lead.next;
}

export function triage(world: World, decisions: Decision[]): Triage {
  const rows: QueueRow[] = [];
  const quiet: OrderBundle[] = [];
  const allItems = new Map<string, AttentionItem[]>();

  for (const order of world.orders) {
    const b = world.bundles.get(order.id)!;
    const items = applyDecisions(orderItems(b, world), decisions);
    allItems.set(order.id, items);
    const open = items.filter(isOpen);
    const lead = leadItem(open);
    if (!lead) {
      quiet.push(b);
      continue;
    }
    const group = open.map((i) => i.group).sort((x, y) => groupRank(x) - groupRank(y))[0]!;
    const risk = Math.max(...open.map((i) => i.risk)) as Risk;
    const inGroup = open.filter((i) => i.group === group && i.clock).sort((x, y) => clockMs(x.clock) - clockMs(y.clock));
    rows.push({
      orderId: order.id, reference: order.reference, bundle: b, group, risk,
      clock: inGroup[0]?.clock ?? lead.clock, lead, reason: situationItem(open)!.title, items: open, next: rowNextStep(lead, open),
      owner: lead.owner ?? open.find((i) => i.owner)?.owner ?? null,
    });
  }

  rows.sort((a, b) =>
    groupRank(a.group) - groupRank(b.group) || b.risk - a.risk || clockMs(a.clock) - clockMs(b.clock) || a.reference.localeCompare(b.reference),
  );
  const byGroup: Record<Group, QueueRow[]> = { decide: [], follow: [], waiting: [] };
  for (const r of rows) byGroup[r.group].push(r);
  return { rows, byGroup, quiet, allItems };
}

/** Desks that own at least one open item, for the filter. */
export function desks(t: Triage): string[] {
  const s = new Set<string>();
  for (const r of t.rows) for (const i of r.items) if (i.owner) s.add(i.owner);
  return [...s].sort();
}

export function matchesDesk(r: QueueRow, desk: string | null): boolean {
  if (!desk) return true;
  if (desk === 'unowned') return r.items.every((i) => !i.owner);
  return r.items.some((i) => i.owner === desk);
}

export function matchesSearch(r: QueueRow, q: string, world: World): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const b = r.bundle;
  const hay = [
    b.order.reference, b.order.customer_reference ?? '', world.customers.get(b.order.customer_id)?.name ?? '',
    ...b.vehicles.map((v) => `${v.make ?? ''} ${v.model ?? ''} ${v.registration ?? ''}`),
    ...r.items.map((i) => i.title),
  ].join(' ').toLowerCase();
  return hay.includes(needle);
}

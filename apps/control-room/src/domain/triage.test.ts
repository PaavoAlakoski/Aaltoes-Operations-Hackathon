import { describe, expect, it } from 'vitest';
import { packetRows, packetWorld } from './testing/loadPacket';
import { buildWorld } from './world';
import { triage, compareItems, leadItem } from './triage';
import { GROUP_ORDER, needsDecision, orderItems } from './attention';
import type { Decision } from './types';

const world = packetWorld();
const ref = (r: string) => world.byReference.get(r)!;

function decision(over: Partial<Decision>): Decision {
  return {
    id: 'd1', order_id: 'ord-00593', target_type: 'proposal', target_id: 'agent-x6ad46f8e74398f5e', action: 'approve',
    note: null, decided_by: 'Shift operator', decided_at: '2026-10-21T09:05:00Z', effects: [], undone_at: null, ...over,
  };
}

describe('triage groups', () => {
  const t = triage(world, []);

  it('brings a person only the orders with a decision waiting, and leaves the rest to the agent', () => {
    expect(t.rows.length + t.quiet.length).toBe(100);
    // Four agent proposals waiting for a yes, and two messages the agent matched to an order.
    expect(t.rows.map((r) => r.reference).sort()).toEqual(['CD-420055', 'CD-420089', 'CD-420299', 'CD-420399', 'CD-420593', 'CD-420719']);
    expect(t.quiet.every((b) => !orderItems(b, world).some(needsDecision))).toBe(true);
    expect(t.rows.every((r) => needsDecision(r.lead))).toBe(true);
  });

  it('offers a person only Approve and Reject; everything else has no button', () => {
    for (const items of t.allItems.values()) {
      for (const i of items) {
        if (i.kind === 'inbox_candidate') expect(i.actions).toEqual(['link', 'not_this']);
        else expect(i.actions.every((a) => a === 'approve' || a === 'reject'), `${i.kind} ${i.id}`).toBe(true);
      }
    }
  });

  it('leaves a critical safety stop with the agent until it brings a proposal', () => {
    expect(t.rows.find((x) => x.reference === 'CD-420322')).toBeUndefined();
    expect(orderItems(ref('CD-420322'), world).some((i) => i.risk === 3)).toBe(true);
  });

  it('puts agents waiting for a yes in Decide now', () => {
    for (const r of ['CD-420593', 'CD-420299', 'CD-420399', 'CD-420055']) {
      expect(t.rows.find((x) => x.reference === r)?.group, r).toBe('decide');
    }
  });

  it('keeps signals without a proposal off the queue: a missed promise, a ferry cutoff, a thread waiting on a site', () => {
    for (const r of ['CD-420702', 'CD-420603', 'CD-420015']) expect(t.rows.find((x) => x.reference === r), r).toBeUndefined();
  });

  it('sends a failed attempt back to the agent instead of to a person', () => {
    const failed = orderItems(ref('CD-420299'), world).find((i) => i.kind === 'proposal' && i.status === 'FAILED')!;
    expect(failed.actions).toEqual([]);
    expect(failed.waitingOn).toBe('agent');
  });

  it('orders rows by group, then risk, then the earliest clock', () => {
    const rank = (g: string) => GROUP_ORDER.indexOf(g as never);
    for (let i = 1; i < t.rows.length; i++) {
      const a = t.rows[i - 1]!;
      const b = t.rows[i]!;
      const ka = [rank(a.group), -a.risk, a.clock ? Date.parse(a.clock.at) : Infinity];
      const kb = [rank(b.group), -b.risk, b.clock ? Date.parse(b.clock.at) : Infinity];
      const clockDiff = ka[2] === kb[2] ? 0 : ka[2]! - kb[2]!;
      const cmp = ka[0]! - kb[0]! || ka[1]! - kb[1]! || clockDiff;
      expect(cmp, `${a.reference} before ${b.reference}`).toBeLessThanOrEqual(0);
    }
  });

  it('leads an order with the agent proposal when one waits for a person', () => {
    expect(t.rows.find((x) => x.reference === 'CD-420593')!.lead.kind).toBe('proposal');
    // A pending proposal leads over a failed one on the same order.
    expect(t.rows.find((x) => x.reference === 'CD-420299')!.lead.status).toBe('PENDING_REVIEW');
  });

  it('leads with the decision, and says what happened in the row', () => {
    const row = t.rows.find((x) => x.reference === 'CD-420593')!;
    expect(row.lead.kind).toBe('proposal');
    expect(row.reason).toBe('Driver found no car at pickup');
  });

  it('counts a conversation filed on one order for the related order too', () => {
    const items = orderItems(ref('CD-420326'), world);
    expect(items.some((i) => i.kind === 'conversation' && i.id === 'conv-x8f5e0de495c9e7b8')).toBe(true);
    expect(orderItems(ref('CD-420399'), world).some((i) => i.id === 'conv-x8f5e0de495c9e7b8')).toBe(true);
  });

  it('flags a moving car whose app has sent no position', () => {
    for (const r of ['CD-420735', 'CD-421013']) {
      expect(orderItems(ref(r), world).some((i) => i.kind === 'silent_driver'), r).toBe(true);
    }
  });

  it('item ordering helper agrees with the lead choice for orders without proposals', () => {
    const items = orderItems(ref('CD-420702'), world);
    expect(leadItem(items)).toBe(items.slice().sort(compareItems)[0]);
  });
});

describe('decisions', () => {
  it('a decided item leaves the queue; undo brings it back', () => {
    const before = triage(world, []).rows.find((r) => r.reference === 'CD-420593')!;
    const after = triage(world, [decision({})]);
    // Its only decision is made, so the order leaves the queue; the agent carries on with the rest.
    expect(before.lead.id).toBe('agent-x6ad46f8e74398f5e');
    expect(after.rows.find((r) => r.reference === 'CD-420593')).toBeUndefined();
    const undone = triage(world, [decision({ undone_at: '2026-10-21T09:06:00Z' })]);
    expect(undone.rows.find((r) => r.reference === 'CD-420593')!.items.length).toBe(before.items.length);
  });

  it('linking one inbox candidate rules out the others', () => {
    const link = decision({ order_id: 'ord-00089', target_type: 'inbox_candidate', target_id: 'inbox-x41075bca6588a2d7#ord-00089', action: 'link' });
    const t = triage(world, [link]);
    const other = t.allItems.get('ord-00719')!.find((i) => i.kind === 'inbox_candidate')!;
    expect(other.decision?.id).toBe(link.id);
  });
});

describe('display_lane is not truth', () => {
  it('changing every display_lane changes nothing in the queue', () => {
    const rows = packetRows().map((r) => (r.collection === 'orders' ? { ...r, data: { ...r.data, display_lane: 'delivered' } } : r));
    const a = triage(world, []).rows.map((r) => `${r.reference}:${r.group}:${r.risk}`);
    const b = triage(buildWorld(rows), []).rows.map((r) => `${r.reference}:${r.group}:${r.risk}`);
    expect(b).toEqual(a);
  });
});

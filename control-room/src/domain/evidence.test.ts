// The evidence rules from dataset/SCHEMA.md (section 4 of the rebuild brief).
import { describe, expect, it } from 'vitest';
import { packetWorld } from './testing/loadPacket';
import {
  accessFact, boardingFact, bookingFact, candidateGuesses, cmrFact, contactFact, deriveStage, isAlertOpen, linkedOrders,
  messageClaim, quoteFact, recordedEffects,
} from './evidence';
import { caseView } from './caseView';
import { orderItems } from './attention';
import type { EndpointDetail } from './types';

const world = packetWorld();
const ref = (r: string) => world.byReference.get(r)!;

describe('a quote is not a booking, and a booking is not a boarding', () => {
  it('shows travel options as quotes, never as confirmed', () => {
    for (const b of world.bundles.values()) for (const o of b.options) expect(quoteFact(o).certainty).toBe('quote');
  });
  it('a booked ferry is a confirmed booking with no boarding unless a gate or driver says so', () => {
    const all = [...world.bundles.values()].flatMap((b) => b.reservations);
    const ferry = all.find((r) => r.kind === 'FERRY' && r.boarding_confirmation === 'UNCONFIRMED' && r.check_in_confirmation === 'UNCONFIRMED')!;
    expect(bookingFact(ferry).certainty).toBe('confirmed');
    expect(bookingFact(ferry).note).toMatch(/not proof of travel/);
    expect(boardingFact(ferry)!.certainty).toBe('missing');
    const scanned = all.find((r) => r.check_in_confirmation === 'CONFIRMED_BY_GATE_SCAN')!;
    expect(boardingFact(scanned)!.certainty).toBe('confirmed');
  });
});

describe('an alert is a signal; acknowledged is not resolved', () => {
  it('keeps acknowledged alerts in the queue', () => {
    const ack = [...world.bundles.values()].flatMap((b) => b.alerts).filter((a) => a.status === 'ACKNOWLEDGED');
    expect(ack.length).toBeGreaterThan(0);
    for (const a of ack) {
      expect(isAlertOpen(a)).toBe(true);
      expect(orderItems(world.bundles.get(a.order_id)!, world).some((i) => i.id === a.id)).toBe(true);
    }
  });
  it('drops resolved alerts', () => {
    const resolved = [...world.bundles.values()].flatMap((b) => b.alerts).find((a) => a.status === 'RESOLVED')!;
    expect(orderItems(world.bundles.get(resolved.order_id)!, world).some((i) => i.id === resolved.id)).toBe(false);
  });
});

describe('a message is a claim by its speaker at its time', () => {
  it('is Stated, with speaker and time', () => {
    const m = ref('CD-420593').messages.find((x) => x.author_type === 'site_contact')!;
    const f = messageClaim(m);
    expect(f.certainty).toBe('stated');
    expect(f.at).toBe(m.authored_at);
    expect(f.by).toBeTruthy();
  });
});

describe('CONFIRMED from the standard site profile is Stated', () => {
  const profile = [...world.bundles.values()].flatMap((b) => b.endpoints)
    .find((e) => e.access_status === 'CONFIRMED' && e.last_confirmed_source === 'MANAGED_SITE_PROFILE')!;
  it('access', () => {
    expect(accessFact(profile).certainty).toBe('stated');
    expect(accessFact(profile).note).toMatch(/not a call about this car/i);
  });
  it('but an order-specific reply is Confirmed', () => {
    const direct = [...world.bundles.values()].flatMap((b) => b.endpoints)
      .find((e) => e.access_status === 'CONFIRMED' && e.last_confirmed_source && e.last_confirmed_source !== 'MANAGED_SITE_PROFILE')!;
    expect(accessFact(direct).certainty).toBe('confirmed');
  });
  it('a missing contact is Missing', () => {
    const ep = { ...profile, contact_name: null, contact_handle: null } as EndpointDetail;
    expect(contactFact(ep).certainty).toBe('missing');
  });
});

describe('a CMR signed with COLLECTION_ONLY scope was signed at pickup', () => {
  it('never reads as a receiver signature', () => {
    const docs = [...world.bundles.values()].flatMap((b) => b.documents).filter((d) => d.signature_scope === 'COLLECTION_ONLY');
    expect(docs.length).toBe(12);
    for (const d of docs) expect(cmrFact(d).value).toMatch(/pickup only, not by the receiver/);
  });
});

describe('inbox candidates are guesses; only linked_order_ids are links', () => {
  it('a pending match has guesses and no links', () => {
    const t = world.inboxThreads.find((x) => x.link_state === 'PENDING_MATCH')!;
    expect(linkedOrders(t)).toEqual([]);
    expect(candidateGuesses(t)).toEqual(['ord-00089', 'ord-00719']);
  });
  it('a guessed order gets a matching decision, not a linked thread', () => {
    const items = orderItems(ref('CD-420089'), world).filter((i) => i.source.table === 'support_inbox_threads');
    expect(items.map((i) => i.kind)).toEqual(['inbox_candidate']);
    expect(items[0]!.actions).toEqual(['link', 'not_this']);
  });
});

describe('proposal text proves nothing; only a linked effect event does', () => {
  it('counts effects only when the event exists', () => {
    const failed = world.proposals.find((p) => p.status === 'FAILED')!;
    expect(recordedEffects(failed, world)).toEqual([]);
    const done = world.proposals.filter((p) => p.status === 'EXECUTED');
    for (const p of done) expect(recordedEffects(p, world).length).toBeGreaterThan(0);
    const fake = { ...done[0]!, execution: { ...done[0]!.execution!, effect_event_ids: ['evt-does-not-exist'] } };
    expect(recordedEffects(fake, world)).toEqual([]);
  });
});

describe('stage is derived, not read from display_lane', () => {
  it('cancelled orders are cancelled even though their status says waiting for pickup', () => {
    const cancelled = world.orders.filter((o) => o.cancelled_at);
    expect(cancelled.length).toBe(2);
    for (const o of cancelled) {
      expect(o.status).toBe('WAITING_FOR_PICKUP');
      expect(deriveStage(world.bundles.get(o.id)!)).toBe('cancelled');
    }
  });
});

describe('a quiet order is not a verified order', () => {
  it('says so on the order page', () => {
    const t = [...world.bundles.values()].find((b) => orderItems(b, world).length === 0 && deriveStage(b) === 'booked')!;
    const v = caseView(t, world, [], []);
    expect(v.quiet).toBe(true);
    expect(v.headline).toMatch(/not the same as verified/);
  });
});

describe('every fact carries a certainty and, unless missing, who said it', () => {
  it('holds for every order', () => {
    for (const b of world.bundles.values()) {
      for (const s of caseView(b, world, orderItems(b, world), []).facts) {
        for (const f of s.facts) {
          expect(['confirmed', 'stated', 'planned', 'quote', 'missing']).toContain(f.certainty);
          if (f.certainty !== 'missing') expect(f.by, `${b.order.reference} ${f.label}`).toBeTruthy();
        }
      }
    }
  });
});

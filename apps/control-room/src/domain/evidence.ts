// The evidence rules from dataset/SCHEMA.md, in one place. Every fact the UI
// shows gets a certainty from here, plus who said it and when.
import type {
  Alert, Document, EndpointDetail, InboxThread, Message, Order, Proposal, Reservation, TravelOption, Tracking,
} from './types';
import type { OrderBundle, World } from './world';
import { STAGE_LABEL, sourceLabel, partyLabel } from './labels';

export type Certainty = 'confirmed' | 'stated' | 'planned' | 'quote' | 'missing';

export interface Fact {
  label: string;
  value: string;
  certainty: Certainty;
  /** Who said it, in words. */
  by: string | null;
  at: string | null;
  /** A short caveat that matters for this fact, such as "not a call about this car". */
  note?: string;
}

// --- Stage ---------------------------------------------------------------

export type Stage = keyof typeof STAGE_LABEL;

/** Stage comes from status, offers and assignments. `display_lane` is never read. */
export function deriveStage(b: Pick<OrderBundle, 'order' | 'offers' | 'assignments'>): Stage {
  const o: Order = b.order;
  if (o.cancelled_at) return 'cancelled';
  if (o.status === 'DELIVERED') return 'delivered';
  if (o.status === 'IN_TRANSIT') return 'moving';
  if (o.status === 'WAITING_FOR_PICKUP') return 'booked';
  if (b.assignments.some((a) => a.status === 'ASSIGNED' || a.status === 'IN_PROGRESS')) return 'booked';
  if (b.offers.some((f) => f.status === 'PUBLISHED')) return 'market';
  return o.readiness_status === 'CONFIRMED' ? 'ready' : 'preparing';
}

// --- Endpoints -----------------------------------------------------------

/**
 * Access instructions. CONFIRMED from the standard site profile is a statement
 * about the site in general, not a check about this car: it is Stated.
 */
export function accessFact(ep: EndpointDetail): Fact {
  const label = ep.boundary === 'PICKUP' ? 'Pickup access' : 'Delivery access';
  if (!ep.access_instruction) return { label, value: 'No access instruction recorded', certainty: 'missing', by: null, at: null };
  if (ep.access_status === 'CONFIRMED' && ep.last_confirmed_source && ep.last_confirmed_source !== 'MANAGED_SITE_PROFILE') {
    return { label, value: ep.access_instruction, certainty: 'confirmed', by: sourceLabel(ep.last_confirmed_source), at: ep.last_confirmed_at };
  }
  if (ep.access_status === 'CONFIRMED') {
    return {
      label, value: ep.access_instruction, certainty: 'stated', by: 'standard site profile',
      at: ep.last_confirmed_at ?? ep.stated_at, note: 'Not a call about this car',
    };
  }
  return { label, value: ep.access_instruction, certainty: 'stated', by: sourceLabel(ep.stated_by), at: ep.stated_at, note: 'Not checked for this order' };
}

export function contactFact(ep: EndpointDetail): Fact {
  const label = ep.boundary === 'PICKUP' ? 'Pickup contact' : 'Delivery contact';
  if (!ep.contact_name && !ep.contact_handle) return { label, value: 'No contact recorded', certainty: 'missing', by: null, at: null };
  const value = [ep.contact_name, ep.contact_role].filter(Boolean).join(', ') || (ep.contact_handle ?? '');
  if (ep.contact_status === 'CONFIRMED' && ep.last_confirmed_source && ep.last_confirmed_source !== 'MANAGED_SITE_PROFILE') {
    return { label, value, certainty: 'confirmed', by: sourceLabel(ep.last_confirmed_source), at: ep.last_confirmed_at };
  }
  if (ep.contact_status === 'CONFIRMED') {
    return { label, value, certainty: 'stated', by: 'standard site profile', at: ep.last_confirmed_at ?? ep.stated_at, note: 'Not a call about this car' };
  }
  return { label, value, certainty: 'stated', by: sourceLabel(ep.stated_by), at: ep.stated_at, note: 'Not confirmed for this order' };
}

/** True when nobody has checked the pickup contact or access for this order. */
export function pickupUnverified(ep: EndpointDetail | undefined): boolean {
  if (!ep) return true;
  return accessFact(ep).certainty !== 'confirmed' || contactFact(ep).certainty !== 'confirmed';
}

// --- Travel: a quote is not a booking, a booking is not a boarding --------

export function quoteFact(opt: TravelOption): Fact {
  const what = `${opt.provider}, ${opt.from_city} → ${opt.to_city}`;
  if (opt.status === 'SOLD_OUT') {
    return { label: `${opt.kind === 'FERRY' ? 'Crossing' : 'Option'} checked`, value: `${what}: sold out`, certainty: 'quote', by: 'availability check', at: opt.checked_at, note: 'Seen at that time; may have changed' };
  }
  const price = opt.quote_cents != null ? ` · ${formatMoney(opt.quote_cents, opt.currency)}` : '';
  return { label: 'Quoted, not booked', value: `${what}${price}`, certainty: 'quote', by: 'price check', at: opt.checked_at, note: 'A quote is not a booking' };
}

export function bookingFact(res: Reservation): Fact {
  const route = res.route_label || [res.from_city, res.to_city].filter(Boolean).join(' → ') || res.city || '';
  return {
    label: `${res.kind.charAt(0)}${res.kind.slice(1).toLowerCase()} booked`,
    value: [route, res.booking_reference].filter(Boolean).join(' · '),
    certainty: res.status === 'BOOKED' ? 'confirmed' : 'stated',
    by: 'booking record',
    at: res.booked_at,
    note: res.kind === 'HOTEL' ? 'A booking, not proof of a stay' : 'A booking, not proof of travel',
  };
}

/** Whether anyone saw the driver or car board. Only a gate scan confirms check-in. */
export function boardingFact(res: Reservation): Fact | null {
  if (res.kind === 'HOTEL') return null;
  if (res.check_in_confirmation === 'CONFIRMED_BY_GATE_SCAN') {
    return { label: 'Check-in', value: 'Checked in at the gate', certainty: 'confirmed', by: 'terminal gate reader', at: res.departure_at };
  }
  if (res.check_in_confirmation === 'REJECTED_BY_GATE_SCAN') {
    return { label: 'Check-in', value: 'Refused at the gate', certainty: 'confirmed', by: 'terminal gate reader', at: res.departure_at };
  }
  if (res.boarding_confirmation === 'DRIVER_REPORTED') {
    return { label: 'Boarding', value: 'Driver says they boarded', certainty: 'stated', by: 'driver', at: res.departure_at };
  }
  return { label: 'Boarding', value: 'No boarding scan', certainty: 'missing', by: null, at: null };
}

// --- Signals and claims ----------------------------------------------------

/** An acknowledged alert has been seen, not resolved. It still needs work. */
export function isAlertOpen(a: Alert): boolean {
  return a.status === 'OPEN' || a.status === 'ACKNOWLEDGED';
}

/** A message is a claim by its speaker at its time, never a verified fact. */
export function messageClaim(m: Message, label = 'Said'): Fact {
  return { label, value: m.body, certainty: 'stated', by: m.author_name_snapshot ?? partyLabel(m.author_type), at: m.authored_at };
}

export function positionFact(t: Tracking | undefined, moving: boolean): Fact | null {
  if (!t) return moving ? { label: 'Last position', value: 'The app has sent no position', certainty: 'missing', by: null, at: null } : null;
  const parts: string[] = [];
  if (t.progress_fraction != null) parts.push(`${Math.round(t.progress_fraction * 100)}% of the way`);
  if (t.distance_remaining_km != null) parts.push(`${t.distance_remaining_km} km to go`);
  return {
    label: 'Last position', value: parts.join(', ') || 'Position received', certainty: 'stated', by: 'driver app',
    at: t.observed_at, note: t.location_quality === 'COARSE' ? 'Coarse, not a map fix' : undefined,
  };
}

/**
 * A digital CMR marked SIGNED with COLLECTION_ONLY scope was signed at pickup.
 * It says nothing about the receiver.
 */
export function cmrFact(doc: Document): Fact {
  if (doc.status === 'SIGNED' && doc.signature_scope === 'COLLECTION_ONLY') {
    return { label: 'Transport document', value: 'Signed at pickup only, not by the receiver', certainty: 'confirmed', by: 'document record', at: doc.updated_at };
  }
  if (doc.status === 'SIGNED' || doc.status === 'VERIFIED') {
    return { label: 'Transport document', value: doc.status === 'VERIFIED' ? 'Verified' : 'Signed', certainty: 'confirmed', by: 'document record', at: doc.updated_at };
  }
  if (doc.status === 'PREPARED') return { label: 'Transport document', value: 'Prepared, not signed', certainty: 'planned', by: 'document record', at: doc.updated_at };
  return { label: 'Transport document', value: 'Not filed', certainty: 'missing', by: null, at: null };
}

/** Inbox candidates are guesses. Only linked_order_ids are links. */
export function linkedOrders(t: InboxThread): string[] {
  return t.linked_order_ids ?? [];
}
export function candidateGuesses(t: InboxThread): string[] {
  const linked = new Set(linkedOrders(t));
  return (t.candidate_order_ids ?? []).filter((id) => !linked.has(id));
}

/** Proposal text proves nothing. Only an effect event that exists in the history does. */
export function recordedEffects(p: Proposal, world: Pick<World, 'eventsById'>): string[] {
  return (p.execution?.effect_event_ids ?? []).filter((id) => world.eventsById.has(id));
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency, maximumFractionDigits: 0 }).format(cents / 100);
}

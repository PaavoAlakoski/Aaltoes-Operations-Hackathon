// How urgent an open incident is, for ordering the incident list. The highest
// rule that applies wins; ties keep the order the list already had.
import type { Incident, Vehicle } from '@bahn/shared';

export const EMERGENCY = { high: 100, medium: 50, low: 10, none: 0 } as const;

/** What the row knows besides the incident: its car and the moves waiting for a decision. */
export interface EmergencyContext {
  vehicle?: Vehicle;
  pending?: number;
}

export function calculateEmergencyScore(incident: Incident, { vehicle, pending = 0 }: EmergencyContext = {}): number {
  // Missed ferry, or the dealer closed / the pickup failed (car not ready, or the driver won't make the handover).
  const pickupFailed = incident.kind === 'car_not_ready' || (vehicle?.status === 'waiting_pickup' && vehicle.pickup_in_time === false);
  if (incident.kind === 'ferry' || pickupFailed) return EMERGENCY.high;
  // Action required (a proposal waits for a person), or the ETA is running late (past delayPhrase's "On time").
  if (pending > 0 || incident.kind === 'delay' || (vehicle?.delay_seconds ?? 0) > 120) return EMERGENCY.medium;
  // No position, or nobody has acknowledged it yet.
  if (incident.kind === 'tracking_gap' || incident.status === 'open') return EMERGENCY.low;
  return EMERGENCY.none;
}

/** Most urgent first. Array sort is stable, so equal scores keep their incoming order. */
export function byEmergency<T>(items: T[], score: (item: T) => number): T[] {
  return items.map((item) => ({ item, s: score(item) })).sort((a, b) => b.s - a.s).map((x) => x.item);
}

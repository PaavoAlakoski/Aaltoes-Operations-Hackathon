// Where a car is on its itinerary at a given moment, so every mover (the
// simulator, the driver app's simulated drive) puts it at the same point.
// A drive leg runs from depart_at to arrive_at along its road at an even
// speed, with a 45-minute stop after every 4½ hours at the wheel (EU rules);
// the ferry crosses its sea route evenly. Before its first leg the car waits
// at the start, and between legs where the last one ended (the port, the dealer).
import type { Leg } from './index';
import { pathKm, pointAlong } from './position';

const MIN = 60_000;
const BLOCK_MIN = 270;
const BREAK_MIN = 45;

export type ScheduledFix = {
  lat: number;
  lng: number;
  /** The leg the car is on, or last finished. */
  leg: Leg;
  /** How far along that leg, 0..1. */
  fraction: number;
  kmLeft: number;
  /** False on a break, before the leg starts and after it ends. */
  moving: boolean;
};

/** How far along a drive or ferry leg the car is at `at`, and whether it is moving then. */
export function legFraction(leg: Leg, at: number): { fraction: number; moving: boolean } {
  const start = Date.parse(leg.depart_at);
  const span = Math.max(Date.parse(leg.arrive_at) - start, MIN);
  if (at <= start) return { fraction: 0, moving: false };
  const t = at - start;
  if (t >= span) return { fraction: 1, moving: false };
  if (leg.kind !== 'drive' || !leg.minutes) return { fraction: t / span, moving: true };

  // The breaks take fixed time; the driving fills the rest, so a delay shows
  // as slower driving. Each block of driving is 4½ h of Google's time,
  // stretched to fit the schedule.
  const breaks = Math.floor(leg.minutes / BLOCK_MIN);
  const driving = Math.max(span - breaks * BREAK_MIN * MIN, MIN);
  const block = BLOCK_MIN * MIN * (driving / (leg.minutes * MIN));
  let driven = 0;
  let clock = 0;
  for (let i = 0; i <= breaks; i++) {
    const run = i < breaks ? block : driving - driven;
    if (t <= clock + run) return { fraction: Math.min((driven + t - clock) / driving, 1), moving: true };
    driven += run;
    clock += run;
    if (i < breaks) {
      if (t <= clock + BREAK_MIN * MIN) return { fraction: driven / driving, moving: false };
      clock += BREAK_MIN * MIN;
    }
  }
  return { fraction: 1, moving: false };
}

/** Where the itinerary puts the car at `at` (ms), or null when it has no road or sea leg. */
export function scheduledPosition(legs: Leg[], at: number): ScheduledFix | null {
  const moves = legs.filter((l) => (l.kind === 'drive' || l.kind === 'ferry') && l.path && l.path.length > 1);
  if (moves.length === 0) return null;
  // The last leg that has started; before the first one, the car waits at its start.
  let leg = moves[0]!;
  for (const l of moves) if (Date.parse(l.depart_at) <= at) leg = l;
  const path = leg.path!;
  const { fraction, moving } = legFraction(leg, at);
  return { ...pointAlong(path, fraction), leg, fraction, kmLeft: (1 - fraction) * pathKm(path), moving };
}

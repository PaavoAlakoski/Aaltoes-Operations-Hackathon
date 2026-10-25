import { describe, expect, it } from 'vitest';
import { delayPhrase, euros, groupProposals, type Suggestion } from './index';

const move = (over: Partial<Suggestion>): Suggestion => ({
  id: 'x', incident_id: 'i1', group_id: 'g1', step: 1, suggestion_type: 'message_vehicle', title: 't',
  rationale: 'r', reasoning_trace: [], payload: {}, cost_cents: null, status: 'pending', model: null,
  decided_at: null, decided_by: null, decision_note: null, executed_at: null, error: null,
  created_at: '2026-10-24T10:00:00Z', updated_at: '2026-10-24T10:00:00Z', ...over,
});

describe('groupProposals', () => {
  it('puts moves of one group together, in step order, with the summary split out', () => {
    const [p, ...rest] = groupProposals([
      move({ id: 'b', step: 2, rationale: 'Cheapest room.', cost_cents: 6400 }),
      move({ id: 'a', step: 1, rationale: 'Leo misses check-in.\n\nEarliest sailing with space.', cost_cents: 7500, reasoning_trace: ['ETA 18:21'] }),
    ]);
    expect(rest).toHaveLength(0);
    expect(p!.moves.map((m) => m.id)).toEqual(['a', 'b']);
    expect(p!.summary).toBe('Leo misses check-in.');
    expect(p!.moves[0]!.rationale).toBe('Earliest sailing with space.');
    expect(p!.checks).toEqual(['ETA 18:21']);
    expect(p!.totalCents).toBe(13900);
  });

  it('treats a move without a group as its own proposal', () => {
    const ps = groupProposals([move({ id: 'a', group_id: null }), move({ id: 'b', group_id: null })]);
    expect(ps).toHaveLength(2);
    expect(ps[0]!.summary).toBe('r');
  });
});

describe('formatting', () => {
  it('says delay the way a dispatcher would', () => {
    expect(delayPhrase(60)).toBe('On time');
    expect(delayPhrase(900)).toBe('15 min late');
    expect(delayPhrase(4800)).toBe('1 h 20 min late');
  });
  it('shows euros', () => {
    expect(euros(7500)).toBe('€75.00');
    expect(euros(null)).toBe('No cost');
  });
});

import { fractionNear, pathKm, pointAlong, type LngLat } from './position';

describe('moving along a corridor', () => {
  const path: LngLat[] = [[24.9384, 60.1699], [25.6612, 60.9827], [25.7473, 62.2426]];
  it('starts and ends on the path ends', () => {
    expect(pointAlong(path, 0)).toEqual({ lng: 24.9384, lat: 60.1699 });
    expect(pointAlong(path, 1).lat).toBeCloseTo(62.2426, 4);
  });
  it('finds its way back from a point to its fraction', () => {
    const p = pointAlong(path, 0.37);
    expect(fractionNear(path, p.lat, p.lng)).toBeCloseTo(0.37, 2);
  });
  it('measures Helsinki to Jyväskylä by the corridor, about 240 km', () => {
    expect(pathKm(path)).toBeGreaterThan(220);
    expect(pathKm(path)).toBeLessThan(260);
  });
});

import { legFraction, scheduledPosition } from './schedule';
import type { Leg } from './index';

describe('where the schedule puts a car', () => {
  const at = (h: number) => Date.UTC(2026, 9, 25, 8) + h * 3600_000;
  const iso = (h: number) => new Date(at(h)).toISOString();
  const place = (lng: number, lat: number) => ({ name: 'x', lat, lng });
  const leg = (over: Partial<Leg>): Leg => ({
    id: 'drive', kind: 'drive', title: 'Drive', from: place(0, 0), to: place(0, 0), depart_at: iso(0), arrive_at: iso(1),
    timezone: 'UTC', arrive_timezone: 'UTC', deadline_at: null, minutes: 60, slack_minutes: 0, instructions: [], link: null,
    booking_ref: null, status: 'now', progress: 0, path: [[0, 0], [1, 0]], km: 111, source: 'google', evidence: [], ...over,
  });

  it('drives evenly through a short leg', () => {
    expect(legFraction(leg({}), at(0.5)).fraction).toBeCloseTo(0.5, 5);
    expect(legFraction(leg({}), at(-1))).toEqual({ fraction: 0, moving: false });
    expect(legFraction(leg({}), at(2))).toEqual({ fraction: 1, moving: false });
  });

  it('stops 45 minutes after 4½ hours at the wheel', () => {
    // Ten hours of driving: two breaks, 11.5 h in all.
    const long = leg({ minutes: 600, arrive_at: iso(11.5) });
    expect(legFraction(long, at(4.5)).fraction).toBeCloseTo(0.45, 5);
    const onBreak = legFraction(long, at(5));
    expect(onBreak).toEqual({ fraction: expect.closeTo(0.45, 5), moving: false });
    expect(legFraction(long, at(5.25 + 4.5)).fraction).toBeCloseTo(0.9, 5);
  });

  it('waits at the port between the drive and the ferry, then crosses', () => {
    const legs = [
      leg({ arrive_at: iso(1) }),
      leg({ id: 'ferry', kind: 'ferry', minutes: null, depart_at: iso(3), arrive_at: iso(5), path: [[1, 0], [1, 1]] }),
    ];
    const port = scheduledPosition(legs, at(2))!;
    expect(port.leg.id).toBe('drive');
    expect(port.moving).toBe(false);
    expect(port.lng).toBeCloseTo(1, 5);
    const sea = scheduledPosition(legs, at(4))!;
    expect(sea.leg.id).toBe('ferry');
    expect(sea.lat).toBeCloseTo(0.5, 3);
  });
});

// What every client of the operations backend shares: the generated database
// types, one way to make a client, the realtime channel names and payloads,
// and a few pure helpers. No keys live here; callers pass the public URL and
// publishable key. The service role key never belongs in a client.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from './database';
import type { LngLat } from './position';

export * from './database';

export type OpsClient = SupabaseClient<Database>;
export type Vehicle = Tables<'vehicles'>;
export type Corridor = Tables<'corridors'>;
export type Incident = Tables<'incidents'>;
export type Message = Tables<'messages'>;
export type Suggestion = Tables<'agent_suggestions'>;
export type Profile = Tables<'profiles'>;
export type Kpis = Tables<'ops_kpis'>;
export type PickupSite = Tables<'pickup_sites'>;
export type DriverTrip = Tables<'driver_trips'>;
export type MarketJob = Tables<'market_jobs'>;
export type DriverStay = Tables<'driver_stays'>;
export type ChatMessage = Tables<'driver_chat_messages'>;

/** One step of a driver's job: getting there, the car's own legs, and home. */
export type Leg = {
  id: string;
  kind: 'train' | 'flight' | 'pickup' | 'drive' | 'ferry' | 'handover';
  title: string;
  from: { name: string; lat: number; lng: number };
  to: { name: string; lat: number; lng: number };
  /** ISO times; a handover's window is depart_at..arrive_at. */
  depart_at: string;
  arrive_at: string;
  /** Where the times are read: departure, and arrival when it is elsewhere (a flight, the ferry). */
  timezone: string;
  arrive_timezone: string;
  /** What the leg must beat, such as ferry check-in closing. */
  deadline_at: string | null;
  /** Driving time without breaks, for drive legs. */
  minutes: number | null;
  /** Time kept spare before what comes next, for a late train or ferry. */
  slack_minutes: number;
  instructions: string[];
  link: { label: string; url: string } | null;
  booking_ref: string | null;
  status: 'done' | 'now' | 'next';
  /** How far along a leg in progress is, 0..1. */
  progress: number;
  /** Road and sea legs: the line to draw and drive along, [lng, lat]. */
  path: LngLat[] | null;
  km: number | null;
  /** Where the times came from: Google, an estimate, the dataset, or the live booking. */
  source: 'google' | 'estimate' | 'dataset' | 'booking' | 'plan';
  /** Dataset records that show a done leg happened. */
  evidence: string[];
};
export type Itinerary = Omit<Tables<'itineraries'>, 'legs'> & { legs: Leg[] };

/**
 * Tells the backend someone has this app open: once a minute while the tab is
 * visible. Google and the agent only run while someone does. Returns a stop.
 */
export function keepPresence(db: OpsClient): () => void {
  const touch = () => {
    // A query only runs once something calls then().
    if (document.visibilityState === 'visible') db.rpc('touch_presence').then(() => {});
  };
  touch();
  const id = setInterval(touch, 60_000);
  document.addEventListener('visibilitychange', touch);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', touch);
  };
}

/** "17:40" in the clock of the place a time refers to. */
export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
}

/** "2 h 35 min", "40 min". */
export function minutesPhrase(min: number): string {
  const m = Math.round(Math.abs(min));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export function createOpsClient(url: string, publishableKey: string, opts: { storageKey?: string; persist?: boolean } = {}): OpsClient {
  return createClient<Database>(url, publishableKey, {
    auth: { persistSession: opts.persist ?? true, storageKey: opts.storageKey ?? 'bahn-ops', autoRefreshToken: true },
  });
}

/** Private Broadcast topic for live positions on a corridor. Drivers send, staff listen. */
export const corridorTopic = (corridorId: string) => `corridor:${corridorId}`;
/** Private Presence topic for staff in the control room. */
export const CONTROL_ROOM_TOPIC = 'control-room';
export const POSITION_EVENT = 'position';

/** What a driver app broadcasts every few seconds. */
export interface PositionPayload {
  vehicle_id: string;
  lat: number;
  lng: number;
  delay_seconds: number;
  at: string;
}

/** What each person in the control room shares through Presence. */
export interface ControlRoomPresence {
  user_id: string;
  name: string;
  role: string;
  viewing_incident: string | null;
}

/** Positions go out live over Broadcast; report_position stores one at most this often. */
export const PERSIST_EVERY_MS = 15_000;

export function euros(cents: number | null | undefined): string {
  if (cents == null) return 'No cost';
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

/** "On time", "5 min late", "1 h 20 min late". */
export function delayPhrase(seconds: number): string {
  if (seconds <= 120) return 'On time';
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min late`;
  return `${Math.floor(min / 60)} h ${min % 60} min late`;
}

export interface Proposal {
  groupId: string;
  incidentId: string;
  /** The facts the agent checked, in order. */
  checks: string[];
  summary: string;
  moves: Suggestion[];
  totalCents: number;
}

/**
 * Groups suggestion rows into proposals: the moves that share a group_id, in
 * step order. The first move's rationale opens with the agent's one-line
 * summary, separated by a blank line; it is split back out here.
 */
export function groupProposals(rows: Suggestion[]): Proposal[] {
  const groups = new Map<string, Suggestion[]>();
  for (const r of rows) {
    const key = r.group_id ?? r.id;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .map(([groupId, moves]) => {
      moves.sort((a, b) => a.step - b.step);
      const first = moves[0]!;
      const [summary, ...rest] = first.rationale.split('\n\n');
      return {
        groupId,
        incidentId: first.incident_id,
        checks: Array.isArray(first.reasoning_trace) ? (first.reasoning_trace as string[]) : [],
        summary: rest.length ? summary! : first.rationale,
        moves: moves.map((m, i) => (i === 0 && rest.length ? { ...m, rationale: rest.join('\n\n') } : m)),
        totalCents: moves.reduce((sum, m) => sum + (m.cost_cents ?? 0), 0),
      };
    })
    .sort((a, b) => b.moves[0]!.created_at.localeCompare(a.moves[0]!.created_at));
}

export * from './position';

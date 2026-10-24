// The live operations room's data: who is signed in, the cars, incidents,
// agent proposals and messages, kept current by Supabase Realtime.
//   Postgres Changes  incidents, messages, agent_suggestions, vehicles, profiles,
//                     pickup sites, driver trips, the driver market and stays (RLS applies)
//   Broadcast         corridor:<id>, live car positions sent by driver apps
//   Presence          control-room, who is on shift and which incident each has open
// Writes go through the RPCs only; the database decides what each role may do.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  CONTROL_ROOM_TOPIC, POSITION_EVENT, corridorTopic, createOpsClient, groupProposals,
  type ControlRoomPresence, type Corridor, type DriverStay, type DriverTrip, type Incident, type Kpis, type MarketJob,
  type Message, type OpsClient, type PickupSite, type PositionPayload, type Profile, type Proposal, type Suggestion,
  type Vehicle,
} from '@bahn/shared';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const opsConfigured = Boolean(url && key);
// Its own client and storage key: the snapshot screens stay signed out.
const db: OpsClient | null = opsConfigured ? createOpsClient(url!, key!, { storageKey: 'bahn-ops-control' }) : null;

export type LiveState = 'connecting' | 'live' | 'offline';
type Status = 'signed-out' | 'loading' | 'ready' | 'error';

export interface MessageDraft {
  to_vehicle?: string;
  to_corridor?: string;
  to_user?: string;
  incident_id?: string | null;
  body: string;
}

interface Ops {
  status: Status;
  error: string | null;
  profile: Profile | null;
  live: LiveState;
  corridors: Corridor[];
  vehicles: Map<string, Vehicle>;
  incidents: Incident[];
  proposals: Proposal[];
  messages: Message[];
  staff: Profile[];
  sites: Map<string, PickupSite>;
  trips: DriverTrip[];
  jobs: MarketJob[];
  stays: DriverStay[];
  kpis: Kpis | null;
  online: ControlRoomPresence[];
  /** The incident this person has open; shared through Presence. */
  viewing: string | null;
  setViewing: (id: string | null) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  acknowledge: (id: string) => Promise<void>;
  assign: (id: string, userId: string | null) => Promise<void>;
  resolve: (id: string, note: string) => Promise<void>;
  decide: (suggestionId: string, decision: 'approve' | 'reject', note?: string) => Promise<void>;
  send: (draft: MessageDraft) => Promise<void>;
  simulateFerryJam: () => Promise<Incident>;
  /** Stages the train-delay scenario; pickup-watch raises the incident a few seconds later. */
  simulateTrainDelay: () => Promise<{ vehicle_id: string; order_ref: string | null }>;
  /** Deletes what was sent while testing: people's messages and reports, the agent's replies and proposals. */
  clearActivity: () => Promise<{ messages: number; incidents: number; suggestions: number }>;
  setVehicleStatus: (vehicleId: string, status: Vehicle['status'], reason: string) => Promise<void>;
}

const Ctx = createContext<Ops | null>(null);

function client(): OpsClient {
  if (!db) throw new Error('The app has no Supabase settings. Copy .env.example to .env and fill it in.');
  return db;
}

/** Throws the database's own message: it is written for people. */
function check<T>(res: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
  if (res.data == null) throw new Error('Nothing came back.');
  return res.data;
}

function upsert<T extends { id: string }>(list: T[], row: T, newestFirst: (a: T, b: T) => number): T[] {
  return [row, ...list.filter((r) => r.id !== row.id)].sort(newestFirst);
}
const byCreated = <T extends { created_at: string }>(a: T, b: T) => b.created_at.localeCompare(a.created_at);

export function OpsProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [status, setStatus] = useState<Status>('signed-out');
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [live, setLive] = useState<LiveState>('connecting');
  const [corridors, setCorridors] = useState<Corridor[]>([]);
  const [vehicles, setVehicles] = useState(new Map<string, Vehicle>());
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [staff, setStaff] = useState<Profile[]>([]);
  const [sites, setSites] = useState(new Map<string, PickupSite>());
  const [trips, setTrips] = useState<DriverTrip[]>([]);
  const [jobs, setJobs] = useState<MarketJob[]>([]);
  const [stays, setStays] = useState<DriverStay[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [online, setOnline] = useState<ControlRoomPresence[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  const presence = useRef<ReturnType<OpsClient['channel']> | null>(null);
  const kpiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!db) {
      setAuthReady(true);
      return;
    }
    db.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data } = db.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const refreshKpis = useCallback(() => {
    if (kpiTimer.current) clearTimeout(kpiTimer.current);
    kpiTimer.current = setTimeout(async () => {
      const { data } = await client().from('ops_kpis').select('*').single();
      if (data) setKpis(data);
    }, 800);
  }, []);

  // Load everything once per sign-in, then subscribe.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!authReady) return;
    if (!userId) {
      setStatus('signed-out');
      setProfile(null);
      return;
    }
    let cancelled = false;
    const sb = client();
    const channels: ReturnType<OpsClient['channel']>[] = [];
    setStatus('loading');
    setError(null);

    (async () => {
      const me = check(await sb.from('profiles').select('*').eq('id', userId).single());
      if (cancelled) return;
      setProfile(me);
      if (me.role === 'driver') {
        setStatus('ready');
        return;
      }
      const since = new Date(Date.now() - 48 * 3600_000).toISOString();
      const [cs, vs, is, ss, ms, ps, k, sts, ts, js, ds] = await Promise.all([
        sb.from('corridors').select('*').order('id'),
        sb.from('vehicles').select('*'),
        sb.from('incidents').select('*').or(`status.neq.resolved,created_at.gte.${since}`).order('created_at', { ascending: false }).limit(200),
        sb.from('agent_suggestions').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(400),
        sb.from('messages').select('*').order('created_at', { ascending: false }).limit(200),
        sb.from('profiles').select('*').order('full_name'),
        sb.from('ops_kpis').select('*').single(),
        sb.from('pickup_sites').select('*'),
        sb.from('driver_trips').select('*').order('created_at', { ascending: false }).limit(100),
        sb.from('market_jobs').select('*'),
        sb.from('driver_stays').select('*').order('created_at', { ascending: false }).limit(100),
      ]);
      if (cancelled) return;
      setCorridors(check(cs));
      setVehicles(new Map(check(vs).map((v) => [v.id, v])));
      setIncidents(check(is));
      setSuggestions(check(ss));
      setMessages(check(ms));
      setStaff(check(ps));
      setKpis(k.data ?? null);
      setSites(new Map(check(sts).map((x) => [x.id, x])));
      setTrips(check(ts));
      setJobs(check(js));
      setStays(check(ds));
      setStatus('ready');

      // Private channels authorise with the signed-in user's token.
      await sb.realtime.setAuth();
      if (cancelled) return;

      const changes = sb
        .channel('ops-db')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, (p) => {
          if (p.eventType === 'DELETE') setIncidents((l) => l.filter((r) => r.id !== (p.old as Incident).id));
          else setIncidents((l) => upsert(l, p.new as Incident, byCreated));
          refreshKpis();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_suggestions' }, (p) => {
          if (p.eventType === 'DELETE') setSuggestions((l) => l.filter((r) => r.id !== (p.old as Suggestion).id));
          else setSuggestions((l) => upsert(l, p.new as Suggestion, byCreated));
          refreshKpis();
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
          setMessages((l) => upsert(l, p.new as Message, byCreated));
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) => {
          setMessages((l) => l.filter((r) => r.id !== (p.old as Message).id));
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vehicles' }, (p) => {
          const v = p.new as Vehicle;
          setVehicles((m) => new Map(m).set(v.id, v));
          refreshKpis();
        })
        // A reassigned driver moves from one car to another.
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, (p) => {
          const row = p.new as Profile;
          setStaff((l) => l.map((x) => (x.id === row.id ? row : x)));
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pickup_sites' }, (p) => {
          if (p.eventType !== 'DELETE') setSites((m) => new Map(m).set((p.new as PickupSite).id, p.new as PickupSite));
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_trips' }, (p) => {
          if (p.eventType === 'DELETE') setTrips((l) => l.filter((r) => r.id !== (p.old as DriverTrip).id));
          else setTrips((l) => upsert(l, p.new as DriverTrip, byCreated));
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'market_jobs' }, (p) => {
          if (p.eventType === 'DELETE') setJobs((l) => l.filter((r) => r.id !== (p.old as MarketJob).id));
          else setJobs((l) => [p.new as MarketJob, ...l.filter((r) => r.id !== (p.new as MarketJob).id)]);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_stays' }, (p) => {
          if (p.eventType === 'DELETE') setStays((l) => l.filter((r) => r.id !== (p.old as DriverStay).id));
          else setStays((l) => upsert(l, p.new as DriverStay, byCreated));
        })
        .subscribe((s) => setLive(s === 'SUBSCRIBED' ? 'live' : s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' ? 'offline' : 'connecting'));
      channels.push(changes);

      for (const c of check(cs)) {
        channels.push(
          sb
            .channel(corridorTopic(c.id), { config: { private: true } })
            .on('broadcast', { event: POSITION_EVENT }, ({ payload }) => {
              const pos = payload as PositionPayload;
              setVehicles((m) => {
                const v = m.get(pos.vehicle_id);
                if (!v) return m;
                return new Map(m).set(v.id, { ...v, lat: pos.lat, lng: pos.lng, delay_seconds: pos.delay_seconds, last_seen_at: pos.at });
              });
            })
            .subscribe(),
        );
      }

      const room = sb.channel(CONTROL_ROOM_TOPIC, { config: { private: true, presence: { key: userId } } });
      room
        .on('presence', { event: 'sync' }, () => {
          const state = room.presenceState<ControlRoomPresence>();
          setOnline(Object.values(state).map((metas) => metas[0]!).filter(Boolean));
        })
        .subscribe(async (s) => {
          if (s === 'SUBSCRIBED') {
            await room.track({ user_id: userId, name: me.full_name, role: me.role, viewing_incident: null } satisfies ControlRoomPresence);
          }
        });
      presence.current = room;
      channels.push(room);
    })().catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });

    return () => {
      cancelled = true;
      presence.current = null;
      for (const ch of channels) sb.removeChannel(ch);
    };
  }, [authReady, userId, refreshKpis]);

  // Tell the rest of the room which incident this person is looking at.
  useEffect(() => {
    if (!presence.current || !profile) return;
    presence.current.track({ user_id: profile.id, name: profile.full_name, role: profile.role, viewing_incident: viewing } satisfies ControlRoomPresence);
  }, [viewing, profile]);

  const proposals = useMemo(() => groupProposals(suggestions), [suggestions]);

  const ops = useMemo<Ops>(() => {
    const sb = () => client();
    const replaceIncident = (row: Incident) => setIncidents((l) => upsert(l, row, byCreated));
    return {
      status: !authReady ? 'loading' : status,
      error, profile, live, corridors, vehicles, incidents, proposals, messages, staff, sites, trips, jobs, stays, kpis, online,
      viewing, setViewing,
      signIn: async (email, password) => {
        const { error } = await sb().auth.signInWithPassword({ email, password });
        if (error) throw new Error(error.message);
      },
      signOut: async () => {
        await sb().auth.signOut();
      },
      acknowledge: async (id) => replaceIncident(check(await sb().rpc('acknowledge_incident', { p_incident_id: id }))),
      assign: async (id, userId) =>
        replaceIncident(check(await sb().rpc('assign_incident', { p_incident_id: id, p_assignee: userId as string }))),
      resolve: async (id, note) => replaceIncident(check(await sb().rpc('resolve_incident', { p_incident_id: id, p_note: note || undefined }))),
      decide: async (suggestionId, decision, note) => {
        const row = check(await sb().rpc('decide_suggestion', { p_suggestion_id: suggestionId, p_decision: decision, p_note: note || undefined }));
        setSuggestions((l) => upsert(l, row, byCreated));
      },
      send: async (draft) => {
        const row = check(await sb().from('messages').insert(draft).select('*').single());
        setMessages((l) => upsert(l, row, byCreated));
      },
      simulateFerryJam: async () => {
        const row = check(await sb().rpc('simulate_ferry_jam'));
        replaceIncident(row);
        return row;
      },
      simulateTrainDelay: async () => check(await sb().rpc('simulate_train_delay')) as { vehicle_id: string; order_ref: string | null },
      clearActivity: async () => {
        const counts = check(await sb().rpc('clear_live_activity')) as { messages: number; incidents: number; suggestions: number };
        // The seeded messages and the system's own incidents stay: read back what is left.
        const since = new Date(Date.now() - 48 * 3600_000).toISOString();
        const [is, ss, ms] = await Promise.all([
          sb().from('incidents').select('*').or(`status.neq.resolved,created_at.gte.${since}`).order('created_at', { ascending: false }).limit(200),
          sb().from('agent_suggestions').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(400),
          sb().from('messages').select('*').order('created_at', { ascending: false }).limit(200),
        ]);
        setIncidents(check(is));
        setSuggestions(check(ss));
        setMessages(check(ms));
        refreshKpis();
        return counts;
      },
      setVehicleStatus: async (vehicleId, s, reason) => {
        const v = check(await sb().rpc('set_vehicle_status', { p_vehicle_id: vehicleId, p_status: s, p_reason: reason }));
        setVehicles((m) => new Map(m).set(v.id, v));
      },
    };
  }, [authReady, status, error, profile, live, corridors, vehicles, incidents, proposals, messages, staff, sites, trips, jobs, stays, kpis, online, viewing, refreshKpis]);

  return <Ctx.Provider value={ops}>{children}</Ctx.Provider>;
}

export function useOps(): Ops {
  const ops = useContext(Ctx);
  if (!ops) throw new Error('useOps outside OpsProvider');
  return ops;
}

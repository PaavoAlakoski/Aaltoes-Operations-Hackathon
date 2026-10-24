// The driver app: one car, one shift. The Overview shows the whole job as legs
// (getting there, the car's own drives and ferry, the way home) when the order
// has an itinerary, else the car and what control sent. It shares the car's
// position (from the phone, or a simulated drive along the road), and lets the
// driver chat with the agent, which tells control only when a problem needs a
// person. Row-level security means it can only ever see this driver's own car,
// messages, chat, itinerary and reports.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  PositionPublisher, createOpsClient, delayPhrase, euros, fractionNear, keepPresence, km, localTime, minutesPhrase, pathKm, pointAlong,
  type ChatMessage, type Corridor, type DriverStay, type Incident, type Itinerary, type Leg, type LngLat, type MarketJob, type Message,
  type OpsClient, type PickupSite, type Profile, type Vehicle,
} from '@bahn/shared';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const db: OpsClient | null = url && key ? createOpsClient(url, key, { storageKey: 'bahn-ops-driver' }) : null;

const SEND_EVERY_MS = 3000;
/** Makes each realtime channel topic unique (see ChatView). */
let channelSeq = 0;
/** A simulated drive covers the corridor fast enough to see it move: ~1.5 km per fix. */
const SIM_KM_PER_FIX = 1.5;
/** Along an itinerary's real road it drives at road speed instead: 85 km/h. */
const ROAD_KM_PER_FIX = (85 * SEND_EVERY_MS) / 3_600_000;

/** The driver's itinerary; the function builds it on first use and keeps it fresh. */
async function fetchItinerary(db: OpsClient): Promise<Itinerary | null> {
  const { data } = await db.functions.invoke<{ itinerary: Itinerary | null }>('build-itinerary', { body: {} });
  return data?.itinerary ?? null;
}

/** What an incident on the driver's car is called in the app. */
const INCIDENT_LABEL: Record<string, string> = {
  breakdown: 'Breakdown', accident: 'Accident', delay: 'Traffic or delay', car_not_ready: 'Car not ready',
  documents: 'Papers or keys', ferry: 'Ferry problem', damage: 'Damage found', other: 'Something else',
  tracking_gap: 'Control lost your position',
};

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!db) return setReady(true);
    db.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = db.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!db) return <Shell><p className="error">Missing Supabase settings. Copy .env.example to .env.</p></Shell>;
  if (!ready) return <Shell><p className="meta">Loading…</p></Shell>;
  if (!session) return <SignIn db={db} />;
  return <Driver db={db} userId={session.user.id} />;
}

function Shell({ children, onSignOut }: { children: React.ReactNode; onSignOut?: () => void }) {
  return (
    <div className="app">
      <header className="bar">
        <span className="brand">Bahn <span className="sub">Driver</span></span>
        {onSignOut && <button type="button" className="link" onClick={onSignOut}>Sign out</button>}
      </header>
      <main className="main">{children}</main>
    </div>
  );
}

function SignIn({ db }: { db: OpsClient }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message);
    setBusy(false);
  }
  return (
    <Shell>
      <form className="card stack" onSubmit={submit}>
        <h1 className="title">Sign in</h1>
        <label className="field"><span>Email</span>
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field"><span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary big" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </Shell>
  );
}

function Driver({ db, userId }: { db: OpsClient; userId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [corridor, setCorridor] = useState<Corridor | null>(null);
  const [shift, setShift] = useState<{ shift_start: string; shift_end: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [site, setSite] = useState<PickupSite | null>(null);
  const [stays, setStays] = useState<DriverStay[]>([]);
  const [offers, setOffers] = useState<MarketJob[]>([]);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'chat' | 'inbox'>('overview');
  // Bumped when control moves this driver onto or off a car.
  const [reload, setReload] = useState(0);
  const carId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await db.from('profiles').select('*').eq('id', userId).single();
      if (me.error) throw new Error(me.error.message);
      if (cancelled) return;
      setProfile(me.data);
      carId.current = me.data.vehicle_id;
      // Messages, stays and job offers reach a driver with or without a car.
      const [m, st, jo] = await Promise.all([
        db.from('messages').select('*').order('created_at', { ascending: false }).limit(50),
        db.from('driver_stays').select('*').order('created_at', { ascending: false }).limit(5),
        db.from('market_jobs').select('*').eq('offered_to', userId),
      ]);
      if (cancelled) return;
      setMessages(m.data ?? []);
      setStays(st.data ?? []);
      setOffers(jo.data ?? []);
      if (!me.data.vehicle_id) {
        setVehicle(null);
        return;
      }
      const [v, a, i] = await Promise.all([
        db.from('vehicles').select('*').eq('id', me.data.vehicle_id).single(),
        db.from('assignments').select('shift_start,shift_end').eq('driver_id', userId).order('shift_start', { ascending: false }).limit(1).maybeSingle(),
        db.from('incidents').select('*').order('created_at', { ascending: false }).limit(20),
      ]);
      if (v.error) throw new Error(v.error.message);
      if (cancelled) return;
      setVehicle(v.data);
      setShift(a.data);
      setIncidents(i.data ?? []);
      const [c, s] = await Promise.all([
        db.from('corridors').select('*').eq('id', v.data.corridor_id).single(),
        v.data.pickup_site_id ? db.from('pickup_sites').select('*').eq('id', v.data.pickup_site_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      if (cancelled) return;
      if (c.data) setCorridor(c.data);
      setSite(s.data);
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [db, userId, reload]);

  useEffect(() => keepPresence(db), [db]);

  // Only drivers on a car have an itinerary, and only some orders have one.
  const vehicleId = vehicle?.id ?? null;
  useEffect(() => {
    if (!vehicleId) return setItinerary(null);
    let cancelled = false;
    fetchItinerary(db).then((it) => !cancelled && setItinerary(it));
    return () => {
      cancelled = true;
    };
  }, [db, vehicleId]);

  // RLS filters these streams to this driver's own rows.
  useEffect(() => {
    const ch = db
      .channel(`driver-db-${++channelSeq}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) =>
        setMessages((l) => [p.new as Message, ...l.filter((x) => x.id !== (p.new as Message).id)]))
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages' }, (p) =>
        setMessages((l) => l.filter((x) => x.id !== (p.old as Message).id)))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, (p) => {
        if (p.eventType === 'DELETE') return setIncidents((l) => l.filter((x) => x.id !== (p.old as Incident).id));
        const row = p.new as Incident;
        if (row?.id) setIncidents((l) => [row, ...l.filter((x) => x.id !== row.id)]);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'vehicles' }, (p) => setVehicle(p.new as Vehicle))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'itineraries' }, (p) => {
        if (p.eventType !== 'DELETE') setItinerary(p.new as unknown as Itinerary);
      })
      // A new ferry booking moves the ferry leg; the function rebuilds when it sees one.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ferry_bookings' }, () => {
        fetchItinerary(db).then(setItinerary);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_stays' }, (p) => {
        if (p.eventType === 'DELETE') return setStays((l) => l.filter((x) => x.id !== (p.old as DriverStay).id));
        setStays((l) => [p.new as DriverStay, ...l.filter((x) => x.id !== (p.new as DriverStay).id)]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'market_jobs' }, (p) => {
        const row = p.new as MarketJob;
        if (!row?.id) return;
        setOffers((l) => (row.offered_to === userId ? [row, ...l.filter((x) => x.id !== row.id)] : l.filter((x) => x.id !== row.id)));
      })
      // Control gave this driver a car, or took one away. The token carries the
      // car id that RLS reads, so refresh it before loading again.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, async (p) => {
        const row = p.new as Profile;
        if (row.id !== userId || row.vehicle_id === carId.current) return;
        await db.auth.refreshSession();
        setReload((n) => n + 1);
      })
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [db, userId, reload]);

  const unread = messages.filter((m) => !m.read_at && m.from_user !== userId && !m.to_corridor).length;
  const signOut = () => db.auth.signOut();

  if (error) return <Shell onSignOut={signOut}><p className="error">{error}</p></Shell>;
  if (!profile) return <Shell><p className="meta">Loading…</p></Shell>;
  if (profile.role !== 'driver') {
    return <Shell onSignOut={signOut}><p className="card">This app is for drivers. Staff sign in on Needs you in the control room app.</p></Shell>;
  }
  const tonight = <Tonight db={db} stays={stays} offers={offers} setOffers={setOffers} />;
  if (!profile.vehicle_id) {
    // A driver with no car still gets control's messages, a booked stay and job offers.
    return (
      <Shell onSignOut={signOut}>
        <p className="hello">Hi {profile.full_name.split(' ')[0]}</p>
        <div className="stack">
          {tonight}
          {stays.length === 0 && offers.length === 0 && <p className="card">You are not on a car right now. Control will put you on one.</p>}
          <Inbox db={db} userId={userId} messages={messages} incidents={incidents} setMessages={setMessages} />
        </div>
      </Shell>
    );
  }
  if (!vehicle) return <Shell onSignOut={signOut}><p className="meta">Loading your car…</p></Shell>;

  return (
    <Shell onSignOut={signOut}>
      <p className="hello">Hi {profile.full_name.split(' ')[0]}</p>
      <nav className="tabs" aria-label="Sections">
        <button type="button" aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>Overview</button>
        <button type="button" aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" aria-pressed={tab === 'inbox'} onClick={() => setTab('inbox')}>
          Inbox{unread > 0 && <span className="badge" aria-label={`${unread} unread`}>{unread}</span>}
        </button>
      </nav>
      {tab === 'overview' && (itinerary ? (
        <Overview db={db} vehicle={vehicle} corridor={corridor} incidents={incidents} itinerary={itinerary} tonight={tonight} />
      ) : (
        <div className="stack">
          {tonight}
          <CarView db={db} vehicle={vehicle} corridor={corridor} shift={shift} incidents={incidents} site={site} />
        </div>
      ))}
      {tab === 'chat' && <ChatView db={db} userId={userId} />}
      {tab === 'inbox' && <Inbox db={db} userId={userId} messages={messages} incidents={incidents} setMessages={setMessages} />}
    </Shell>
  );
}

const STATUS_WORD: Record<Vehicle['status'], string> = {
  waiting_pickup: 'Waiting for pickup', moving: 'On the road', stopped: 'Stopped', on_ferry: 'On the ferry',
  needs_check: 'Needs a check', delivered: 'Delivered', offline: 'Offline',
};

function time(iso: string) {
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Google Maps directions to a point; opens the Maps app on a phone. */
const directions = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

/** Message text with its links made tappable (the agent sends Maps links). */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p)
          ? <a key={i} href={p} target="_blank" rel="noreferrer">{p.includes('google.com/maps') ? 'Open in Google Maps' : p}</a>
          : p)}
    </>
  );
}

/** Tonight's stay and any job control has offered, with a yes or no. */
function Tonight({ db, stays, offers, setOffers }: {
  db: OpsClient; stays: DriverStay[]; offers: MarketJob[]; setOffers: (f: (l: MarketJob[]) => MarketJob[]) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const stay = stays[0];
  async function answer(job: MarketJob, accept: boolean) {
    setErr(null);
    const { data, error } = await db.rpc('answer_market_job', { p_job_id: job.id, p_accept: accept });
    if (error) return setErr(error.message);
    setOffers((l) => l.map((x) => (x.id === data.id ? data : x)));
  }
  if (!stay && offers.length === 0) return null;
  return (
    <>
      {stay && (
        <section className="card stack">
          <p className="meta">Tonight</p>
          <h1 className="title">{stay.name}</h1>
          <p>{stay.address}</p>
          <p className="meta">{stay.nights} night{stay.nights > 1 ? 's' : ''} · pay at the hotel and claim it back with the receipt</p>
          {stay.lat != null && stay.lng != null && (
            <a className="primary big" href={directions(stay.lat, stay.lng)} target="_blank" rel="noreferrer">Navigate to the hotel</a>
          )}
        </section>
      )}
      {offers.map((j) => (
        <section key={j.id} className="card stack">
          <p className="meta">A job for tomorrow, if you want it</p>
          <h1 className="title">{j.label}</h1>
          <p>{j.pickup_name}, {j.pickup_city} → {j.delivery_city}</p>
          <p className="meta">
            Pickup {localTime(j.window_start, j.timezone)}–{localTime(j.window_end, j.timezone)} local · {euros(j.fee_cents)} · <span className="mono">{j.order_ref}</span>
          </p>
          {j.status === 'offered' ? (
            <div className="segmented" role="group" aria-label="Take this job?">
              <button type="button" onClick={() => answer(j, true)}>Accept</button>
              <button type="button" onClick={() => answer(j, false)}>Decline</button>
            </div>
          ) : (
            <p className={j.status === 'accepted' ? 'ok' : 'meta'}>{j.status === 'accepted' ? 'You accepted. Control will confirm.' : 'You declined.'}</p>
          )}
        </section>
      ))}
      {err && <p className="error" role="alert">{err}</p>}
    </>
  );
}

type Live = { progress: number; eta: number | null; slack: number | null };

/** "Sat 21:02" in the clock of the place a time belongs to. */
function when(iso: string, timeZone: string) {
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone });
}

/** A leg's time span; the arrival gets its weekday only when it is another day. */
function span(leg: Leg, arrive: string) {
  if (leg.kind === 'pickup') return when(leg.depart_at, leg.timezone);
  const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
  const sameDay = day(leg.depart_at, leg.timezone) === day(arrive, leg.arrive_timezone);
  const end = sameDay
    ? new Date(arrive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: leg.arrive_timezone })
    : when(arrive, leg.arrive_timezone);
  return `${when(leg.depart_at, leg.timezone)} – ${end}`;
}

/** Spare time in words: minutes and hours, or days for long waits. */
function spare(min: number) {
  return min >= 2 * 1440 ? `${Math.floor(min / 1440)} days` : min >= 1440 ? '1 day' : minutesPhrase(min);
}

/** How far along a path the vertex nearest to a point is, 0..1. */
function progressOn(path: LngLat[], lat: number, lng: number): number {
  const total = pathKm(path) || 1;
  let run = 0, best = 0, bestKm = Infinity;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) run += km(path[i - 1]!, path[i]!);
    const d = km(path[i]!, [lng, lat]);
    if (d < bestKm) {
      bestKm = d;
      best = run;
    }
  }
  return best / total;
}

const KIND_WORD: Record<Leg['kind'], string> = {
  train: 'Train', flight: 'Flight', pickup: 'Pickup', drive: 'Drive', ferry: 'Ferry', handover: 'Handover',
};

/** The whole job: where it stands, then every leg with what to do and how to book it. */
function Overview({ db, vehicle, corridor, incidents, itinerary, tonight }: {
  db: OpsClient; vehicle: Vehicle; corridor: Corridor | null; incidents: Incident[]; itinerary: Itinerary; tonight: React.ReactNode;
}) {
  const legs = itinerary.legs;
  const now = legs.find((l) => l.status === 'now') ?? null;
  // The drive in progress follows the car's live position, not the snapshot
  // the itinerary was built from: what is left, breaks, and the current delay.
  const live = useMemo<Live | null>(() => {
    if (now?.kind !== 'drive' || !now.path || vehicle.lat == null || vehicle.lng == null) return null;
    const progress = progressOn(now.path, vehicle.lat, vehicle.lng);
    if (now.minutes == null) return { progress, eta: null, slack: null };
    const left = (1 - progress) * now.minutes;
    const eta = Date.now() + (left + Math.floor(left / 270) * 45) * 60_000 + vehicle.delay_seconds * 1000;
    return { progress, eta, slack: now.deadline_at ? Math.round((Date.parse(now.deadline_at) - eta) / 60_000) : null };
  }, [now, vehicle.lat, vehicle.lng, vehicle.delay_seconds]);
  const done = legs.filter((l) => l.status === 'done').length + (live?.progress ?? now?.progress ?? 0);
  const share = Math.round((done / legs.length) * 100);
  const pickup = legs.find((l) => l.kind === 'pickup');
  const handover = legs.find((l) => l.kind === 'handover');

  return (
    <div className="stack">
      <section className="card summary">
        <p className="eyebrow">Your job</p>
        <h1 className="title">{vehicle.label}</h1>
        <p className="meta">
          {pickup?.to.name} → {handover?.to.name} · <span className="mono">{vehicle.order_ref}</span>
        </p>
        <div className="row">
          {now && <span className="chip" data-tone="warn">Now · {now.title}</span>}
          {handover && <span className="chip">Hand over {when(handover.depart_at, handover.timezone)}</span>}
        </div>
        <div className="meter" role="img" aria-label={`${share}% of the job done`}><span style={{ width: `${share}%` }} /></div>
      </section>
      {tonight}
      <ol className="timeline" aria-label="Your trips">
        {legs.map((leg, i) => <LegItem key={leg.id} leg={leg} n={i + 1} live={leg === now ? live : null} />)}
      </ol>
      {corridor && (
        <LocationSharing
          db={db} vehicle={vehicle} corridor={corridor}
          route={now?.kind === 'drive' ? now.path : null} routeEnd={now?.to.name} atSea={now?.kind === 'ferry'}
        />
      )}
      <OpenIncidents incidents={incidents} />
    </div>
  );
}

function LegItem({ leg, n, live }: { leg: Leg; n: number; live: Live | null }) {
  const progress = live?.progress ?? leg.progress;
  const slack = live?.slack ?? leg.slack_minutes;
  const arrive = live?.eta != null ? new Date(live.eta).toISOString() : leg.arrive_at;
  const travels = leg.from.name !== leg.to.name;
  const details = (
    <div className="leg-card">
      {leg.status === 'now' && leg.path && (
        <div className="meter" role="img" aria-label={`${Math.round(progress * 100)}% of this leg done`}>
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      <ul className="steps">{leg.instructions.map((s, i) => <li key={i}><Linked text={s} /></li>)}</ul>
      <div className="chips">
        <SlackChip leg={leg} minutes={slack} />
        {leg.booking_ref && <span className="chip">Booking {leg.booking_ref}</span>}
        {leg.km != null && <span className="chip">{Math.round(leg.km)} km</span>}
      </div>
      {leg.link && (
        <div className="actions">
          <a className={leg.status === 'now' ? 'primary' : 'ghost'} href={leg.link.url} target="_blank" rel="noreferrer">{leg.link.label}</a>
        </div>
      )}
    </div>
  );
  return (
    <li className="leg" data-status={leg.status} aria-current={leg.status === 'now' ? 'step' : undefined}>
      <span className="dot" aria-hidden>{leg.status === 'done' ? '✓' : n}</span>
      <div className="leg-body">
        <div className="leg-head">
          <span className="leg-title">{leg.title}</span>
          <span className="leg-time">{span(leg, arrive)}</span>
        </div>
        <p className="leg-sub">
          {KIND_WORD[leg.kind]} · {travels ? `${leg.from.name} → ${leg.to.name}` : leg.to.name}
          {leg.status === 'done' && (leg.evidence.length > 0 ? ' · recorded' : ' · done')}
        </p>
        {leg.status === 'now' ? details : leg.status === 'next' && <details className="more"><summary>Details</summary>{details}</details>}
      </div>
    </li>
  );
}

/** Spare time before what comes next, or how late the leg runs. */
function SlackChip({ leg, minutes }: { leg: Leg; minutes: number }) {
  if (leg.status === 'done' || leg.kind === 'pickup' || leg.kind === 'handover') return null;
  if (minutes < 0) return <span className="chip" data-tone="warn">{spare(-minutes)} late</span>;
  return <span className="chip" data-tone="ok">{spare(minutes)} spare</span>;
}

function CarView({ db, vehicle, corridor, shift, incidents, site }: {
  db: OpsClient; vehicle: Vehicle; corridor: Corridor | null; shift: { shift_start: string; shift_end: string } | null; incidents: Incident[];
  site: PickupSite | null;
}) {
  return (
    <div className="stack">
      {vehicle.status === 'waiting_pickup' && site && (
        <section className="card stack">
          <p className="meta">Pick up</p>
          <h1 className="title">{site.name}</h1>
          <p>{site.city}{site.closes_at && <> · keys {site.key_handover === 'key_box' ? 'from the key box' : 'in person'} until <strong>{localTime(site.closes_at, site.timezone)}</strong> local</>}</p>
          {site.access_note && <p className="meta">{site.access_note}</p>}
          <a className="primary big" href={directions(site.lat, site.lng)} target="_blank" rel="noreferrer">Navigate to the dealer</a>
        </section>
      )}
      <section className="card">
        <p className="meta">Your car</p>
        <h1 className="title">{vehicle.label}</h1>
        <p className="mono">{vehicle.registration ?? 'No plate yet'} · {vehicle.order_ref}</p>
        <dl className="facts">
          <div><dt>Status</dt><dd>{STATUS_WORD[vehicle.status]}</dd></div>
          <div><dt>Delivery</dt><dd>{vehicle.eta ? `${time(vehicle.eta)} · ${delayPhrase(vehicle.delay_seconds)}` : 'Not planned yet'}</dd></div>
          <div><dt>Route</dt><dd>{corridor?.name ?? '…'}</dd></div>
          {shift && <div><dt>Shift</dt><dd>{time(shift.shift_start)} – {time(shift.shift_end)}</dd></div>}
        </dl>
      </section>
      {corridor && <LocationSharing db={db} vehicle={vehicle} corridor={corridor} />}
      <OpenIncidents incidents={incidents} />
    </div>
  );
}

function OpenIncidents({ incidents }: { incidents: Incident[] }) {
  const open = incidents.filter((i) => i.status !== 'resolved');
  if (open.length === 0) return null;
  return (
    <section className="card">
      <p className="eyebrow">Open on your car</p>
      <ul className="list">
        {open.map((i) => (
          <li key={i.id}>
            <strong>{INCIDENT_LABEL[i.kind] ?? 'Something to check'}</strong>{' '}
            <span className="meta">
              {i.source === 'driver' ? (i.status === 'acknowledged' ? 'Control has it' : 'Sent, waiting for control') : 'Raised by control'}
              {' · '}{time(i.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Shares the car's position: the phone's GPS, or a simulated drive. With an
 * itinerary the drive follows the real road of the leg in progress at road
 * speed and stops at its end; otherwise it loops along the corridor quickly.
 */
function LocationSharing({ db, vehicle, corridor, route = null, routeEnd, atSea = false }: {
  db: OpsClient; vehicle: Vehicle; corridor: Corridor; route?: LngLat[] | null; routeEnd?: string; atSea?: boolean;
}) {
  const [mode, setMode] = useState<'off' | 'gps' | 'simulate'>('off');
  const [last, setLast] = useState<{ at: Date; stored: boolean; error?: string } | null>(null);
  const [kmLeft, setKmLeft] = useState<number | null>(null);
  const path = useMemo(() => route ?? (corridor.path as LngLat[]), [route, corridor]);
  const total = useMemo(() => pathKm(path), [path]);
  const fraction = useRef(0);
  const fix = useRef<{ lat: number; lng: number } | null>(null);
  // Start from where the car is whenever the line to follow changes.
  const start = useRef({ lat: vehicle.lat, lng: vehicle.lng });
  start.current = { lat: vehicle.lat, lng: vehicle.lng };
  useEffect(() => {
    const { lat, lng } = start.current;
    fraction.current = lat != null && lng != null ? fractionNear(path, lat, lng) : 0;
  }, [path]);

  useEffect(() => {
    if (mode === 'off') return;
    const publisher = new PositionPublisher(db, corridor.id, vehicle.id);
    let watch: number | null = null;
    if (mode === 'gps') {
      // Browsers only offer location on https or localhost.
      if (!navigator.geolocation) {
        setLast({ at: new Date(), stored: false, error: 'Location needs https on this device.' });
        return () => publisher.close();
      }
      watch = navigator.geolocation.watchPosition(
        (p) => (fix.current = { lat: p.coords.latitude, lng: p.coords.longitude }),
        (e) => setLast({ at: new Date(), stored: false, error: `Location: ${e.message}` }),
        { enableHighAccuracy: true, maximumAge: 5000 },
      );
    }
    const tick = async () => {
      if (mode === 'simulate') {
        if (route) {
          fraction.current = Math.min(1, fraction.current + ROAD_KM_PER_FIX / (total || 1));
          setKmLeft((1 - fraction.current) * total);
        } else {
          fraction.current = (fraction.current + SIM_KM_PER_FIX / Math.max(1, (path.length - 1) * 120)) % 1;
        }
        fix.current = pointAlong(path, fraction.current);
      }
      if (!fix.current) return;
      const r = await publisher.publish(fix.current.lat, fix.current.lng, vehicle.delay_seconds);
      setLast({ at: new Date(), stored: r.stored, error: r.error });
    };
    tick();
    const id = setInterval(tick, SEND_EVERY_MS);
    return () => {
      clearInterval(id);
      if (watch != null) navigator.geolocation.clearWatch(watch);
      publisher.close();
    };
  }, [mode, db, corridor.id, vehicle.id, vehicle.delay_seconds, path, route, total]);

  const simulating = mode === 'simulate' && route != null;
  const arrived = simulating && kmLeft != null && kmLeft < 0.05;

  return (
    <section className="card stack">
      <p className="eyebrow">Location</p>
      <div className="segmented" role="group" aria-label="Share location">
        <button type="button" aria-pressed={mode === 'off'} onClick={() => setMode('off')}>Off</button>
        <button type="button" aria-pressed={mode === 'gps'} onClick={() => setMode('gps')}>Phone GPS</button>
        {!atSea && <button type="button" aria-pressed={mode === 'simulate'} onClick={() => setMode('simulate')}>Simulated drive</button>}
      </div>
      <p className="meta" aria-live="polite">
        {mode === 'off' ? (atSea ? 'On the ferry; share your phone position if you like.' : 'Control cannot see where you are.') : last ? (
          last.error ? <span className="error">{last.error}</span> : arrived ? `Arrived at ${routeEnd ?? 'the end of the road'}.` : (
            `Sent ${last.at.toLocaleTimeString()}${last.stored ? ' · saved' : ''}` +
            (simulating && kmLeft != null ? ` · ${Math.round(kmLeft)} km to ${routeEnd ?? 'go'} at 85 km/h` : '')
          )
        ) : 'Starting…'}
      </p>
    </section>
  );
}

/**
 * The driver's chat with the agent. The agent sorts out what it can and tells
 * control only about a delay of a day or more, a breakdown, or extra costs.
 */
function ChatView({ db, userId }: { db: OpsClient; userId: string }) {
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const add = (rows: ChatMessage[]) =>
    setChat((l) => [...l.filter((x) => !rows.some((r) => r.id === x.id)), ...rows].sort((a, b) => a.created_at.localeCompare(b.created_at)));

  useEffect(() => {
    db.from('driver_chat_messages').select('*').eq('driver_id', userId).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setChat((data ?? []).reverse()));
    // A fresh topic each time: removeChannel finishes later, and reusing the old,
    // still-joined channel makes .on() throw, which blanks the app.
    const ch = db
      .channel(`driver-chat-${++channelSeq}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'driver_chat_messages' }, (p) => add([p.new as ChatMessage]))
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [db, userId]);

  // Braces, not an expression: browsers now return a Promise from
  // scrollIntoView, and React would call it as the cleanup and crash.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.length, busy]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await db.functions.invoke<{ messages: ChatMessage[] }>('driver-chat', { body: { message: text } });
    setBusy(false);
    if (error || !data) return setErr('Could not reach the assistant. Try again; if anyone is hurt, call 112.');
    add(data.messages);
    setBody('');
  }

  return (
    <div className="stack">
      {chat.length === 0 && (
        <p className="card meta">
          Tell the assistant what is going on: traffic, a problem with the car, a question about the pickup. It helps you
          straight away and tells control when something needs them. If anyone is hurt, call 112 first.
        </p>
      )}
      <ol className="messages chat">
        {chat.map((m) => (
          <li key={m.id} className="card" data-mine={m.role === 'driver' || undefined}>
            <p className="meta">
              {m.role === 'driver' ? 'You' : 'Assistant'} · {time(m.created_at)}
              {m.incident_id && <span className="notified">Control notified</span>}
            </p>
            <p className="body"><Linked text={m.body} /></p>
          </li>
        ))}
        {busy && <li className="card meta" aria-live="polite">Assistant is thinking…</li>}
      </ol>
      <div ref={end} />
      <form className="card stack" onSubmit={send}>
        <label className="field"><span>Message</span>
          <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} required />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary" type="submit" disabled={busy || !body.trim()}>{busy ? 'Sending…' : 'Send'}</button>
      </form>
    </div>
  );
}

function Inbox({ db, userId, messages, incidents, setMessages }: {
  db: OpsClient; userId: string; messages: Message[]; incidents: Incident[]; setMessages: (f: (l: Message[]) => Message[]) => void;
}) {
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  // Reply to the last person in control who wrote, or whoever has an open report.
  const replyTo = messages.find((m) => m.from_user && m.from_user !== userId)?.from_user
    ?? incidents.find((i) => i.assigned_to && i.status !== 'resolved')?.assigned_to ?? null;

  useEffect(() => {
    for (const m of messages) {
      if (!m.read_at && m.from_user !== userId && !m.to_corridor) {
        db.rpc('mark_message_read', { p_message_id: m.id }).then(({ error }) => {
          if (!error) setMessages((l) => l.map((x) => (x.id === m.id ? { ...x, read_at: new Date().toISOString() } : x)));
        });
      }
    }
  }, [messages, db, userId, setMessages]);

  async function reply(e: FormEvent) {
    e.preventDefault();
    if (!replyTo) return;
    setErr(null);
    const { data, error } = await db.from('messages').insert({ to_user: replyTo, body }).select('*').single();
    if (error) return setErr(error.message);
    setMessages((l) => [data, ...l]);
    setBody('');
  }

  return (
    <div className="stack">
      {messages.length === 0 ? <p className="card meta">No messages from control yet.</p> : (
        <ol className="messages">
          {messages.map((m) => (
            <li key={m.id} className="card" data-mine={m.from_user === userId || undefined}>
              <p className="meta">
                {m.from_user === userId ? 'You' : m.from_user ? 'Control' : 'Control (agent)'}
                {m.to_corridor ? ' · to everyone on your route' : ''} · {time(m.created_at)}
              </p>
              <p><Linked text={m.body} /></p>
            </li>
          ))}
        </ol>
      )}
      {replyTo ? (
        <form className="card stack" onSubmit={reply}>
          <label className="field"><span>Reply to control</span>
            <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} required />
          </label>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="primary" type="submit" disabled={!body.trim()}>Send</button>
        </form>
      ) : (
        <p className="meta">You can reply once someone in control has written to you. To raise something new, use Chat.</p>
      )}
    </div>
  );
}

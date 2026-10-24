// The driver app: one car, one shift. Shows the car and what control sent,
// shares the car's position (from the phone, or a simulated drive along the
// corridor), and reports problems with one tap. Row-level security means it
// can only ever see this driver's own car, messages and reports.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  PositionPublisher, createOpsClient, delayPhrase, fractionNear, pointAlong,
  type Corridor, type Incident, type LngLat, type Message, type OpsClient, type Profile, type Vehicle,
} from '@bahn/shared';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const db: OpsClient | null = url && key ? createOpsClient(url, key, { storageKey: 'bahn-ops-driver' }) : null;

const SEND_EVERY_MS = 3000;
/** A simulated drive covers the corridor fast enough to see it move: ~1.5 km per fix. */
const SIM_KM_PER_FIX = 1.5;

const REPORTS = [
  { kind: 'breakdown', label: 'Breakdown', severity: 'high' },
  { kind: 'accident', label: 'Accident', severity: 'critical' },
  { kind: 'delay', label: 'Traffic or delay', severity: 'medium' },
  { kind: 'car_not_ready', label: 'Car not ready', severity: 'medium' },
  { kind: 'documents', label: 'Papers or keys', severity: 'medium' },
  { kind: 'ferry', label: 'Ferry problem', severity: 'high' },
  { kind: 'damage', label: 'Damage found', severity: 'high' },
  { kind: 'other', label: 'Something else', severity: 'low' },
] as const;

type Report = (typeof REPORTS)[number];

/** Kinds a driver does not report but can see on their car. */
const OTHER_KIND: Record<string, string> = { tracking_gap: 'Control lost your position' };

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
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'car' | 'report' | 'inbox'>('car');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await db.from('profiles').select('*').eq('id', userId).single();
      if (me.error) throw new Error(me.error.message);
      if (cancelled) return;
      setProfile(me.data);
      if (!me.data.vehicle_id) return;
      const [v, a, m, i] = await Promise.all([
        db.from('vehicles').select('*').eq('id', me.data.vehicle_id).single(),
        db.from('assignments').select('shift_start,shift_end').order('shift_start', { ascending: false }).limit(1).maybeSingle(),
        db.from('messages').select('*').order('created_at', { ascending: false }).limit(50),
        db.from('incidents').select('*').order('created_at', { ascending: false }).limit(20),
      ]);
      if (v.error) throw new Error(v.error.message);
      if (cancelled) return;
      setVehicle(v.data);
      setShift(a.data);
      setMessages(m.data ?? []);
      setIncidents(i.data ?? []);
      const c = await db.from('corridors').select('*').eq('id', v.data.corridor_id).single();
      if (!cancelled && c.data) setCorridor(c.data);
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [db, userId]);

  // RLS filters these streams to this driver's own rows.
  useEffect(() => {
    if (!vehicle) return;
    const ch = db
      .channel('driver-db')
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
      .subscribe();
    return () => {
      db.removeChannel(ch);
    };
  }, [db, vehicle?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const unread = messages.filter((m) => !m.read_at && m.from_user !== userId && !m.to_corridor).length;
  const signOut = () => db.auth.signOut();

  if (error) return <Shell onSignOut={signOut}><p className="error">{error}</p></Shell>;
  if (!profile) return <Shell><p className="meta">Loading…</p></Shell>;
  if (profile.role !== 'driver') {
    return <Shell onSignOut={signOut}><p className="card">This app is for drivers. Staff sign in on Needs you in the control room app.</p></Shell>;
  }
  if (!profile.vehicle_id) {
    return <Shell onSignOut={signOut}><p className="card">You are not on a car yet. Control will put you on one.</p></Shell>;
  }
  if (!vehicle) return <Shell onSignOut={signOut}><p className="meta">Loading your car…</p></Shell>;

  return (
    <Shell onSignOut={signOut}>
      <p className="hello">Hi {profile.full_name.split(' ')[0]}</p>
      <nav className="tabs" aria-label="Sections">
        <button type="button" aria-pressed={tab === 'car'} onClick={() => setTab('car')}>Car</button>
        <button type="button" aria-pressed={tab === 'report'} onClick={() => setTab('report')}>Report</button>
        <button type="button" aria-pressed={tab === 'inbox'} onClick={() => setTab('inbox')}>
          Inbox{unread > 0 && <span className="badge" aria-label={`${unread} unread`}>{unread}</span>}
        </button>
      </nav>
      {tab === 'car' && <CarView db={db} vehicle={vehicle} corridor={corridor} shift={shift} incidents={incidents} />}
      {tab === 'report' && <ReportView db={db} vehicle={vehicle} onDone={() => setTab('car')} />}
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

function CarView({ db, vehicle, corridor, shift, incidents }: {
  db: OpsClient; vehicle: Vehicle; corridor: Corridor | null; shift: { shift_start: string; shift_end: string } | null; incidents: Incident[];
}) {
  const open = incidents.filter((i) => i.status !== 'resolved');
  return (
    <div className="stack">
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
      {open.length > 0 && (
        <section className="card">
          <p className="meta">Open on your car</p>
          <ul className="list">
            {open.map((i) => (
              <li key={i.id}>
                <strong>{REPORTS.find((r) => r.kind === i.kind)?.label ?? OTHER_KIND[i.kind] ?? 'Something to check'}</strong>{' '}
                <span className="meta">
                  {i.source === 'driver' ? (i.status === 'acknowledged' ? 'Control has it' : 'Sent, waiting for control') : 'Raised by control'}
                  {' · '}{time(i.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Shares the car's position: the phone's GPS, or a simulated drive along the corridor. */
function LocationSharing({ db, vehicle, corridor }: { db: OpsClient; vehicle: Vehicle; corridor: Corridor }) {
  const [mode, setMode] = useState<'off' | 'gps' | 'simulate'>('off');
  const [last, setLast] = useState<{ at: Date; stored: boolean; error?: string } | null>(null);
  const path = useMemo(() => corridor.path as LngLat[], [corridor]);
  const fraction = useRef(vehicle.lat != null && vehicle.lng != null ? fractionNear(path, vehicle.lat, vehicle.lng) : 0);
  const fix = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (mode === 'off') return;
    const publisher = new PositionPublisher(db, corridor.id, vehicle.id);
    let watch: number | null = null;
    if (mode === 'gps') {
      watch = navigator.geolocation.watchPosition(
        (p) => (fix.current = { lat: p.coords.latitude, lng: p.coords.longitude }),
        (e) => setLast({ at: new Date(), stored: false, error: `Location: ${e.message}` }),
        { enableHighAccuracy: true, maximumAge: 5000 },
      );
    }
    const tick = async () => {
      if (mode === 'simulate') {
        const total = Math.max(1, (path.length - 1) * 120);
        fraction.current = (fraction.current + SIM_KM_PER_FIX / total) % 1;
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
  }, [mode, db, corridor.id, vehicle.id, vehicle.delay_seconds, path]);

  return (
    <section className="card stack">
      <p className="meta">Location</p>
      <div className="segmented" role="group" aria-label="Share location">
        <button type="button" aria-pressed={mode === 'off'} onClick={() => setMode('off')}>Off</button>
        <button type="button" aria-pressed={mode === 'gps'} onClick={() => setMode('gps')}>Phone GPS</button>
        <button type="button" aria-pressed={mode === 'simulate'} onClick={() => setMode('simulate')}>Simulated drive</button>
      </div>
      <p className="meta" aria-live="polite">
        {mode === 'off' ? 'Control cannot see where you are.' : last ? (
          last.error ? <span className="error">{last.error}</span> : `Sent ${last.at.toLocaleTimeString()}${last.stored ? ' · saved' : ''}`
        ) : 'Starting…'}
      </p>
    </section>
  );
}

function ReportView({ db, vehicle, onDone }: { db: OpsClient; vehicle: Vehicle; onDone: () => void }) {
  const [picked, setPicked] = useState<Report | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setErr(null);
    const { error } = await db.from('incidents').insert({ vehicle_id: vehicle.id, kind: picked.kind, severity: picked.severity, description: note.trim() });
    setBusy(false);
    if (error) return setErr(error.message);
    setSent(true);
    setTimeout(onDone, 1500);
  }

  if (sent) return <p className="card ok" role="status">Sent. Control has been told.</p>;
  if (!picked) {
    return (
      <div className="grid" role="group" aria-label="What happened?">
        {REPORTS.map((r) => (
          <button key={r.kind} type="button" className="tile" data-severity={r.severity} onClick={() => setPicked(r)}>{r.label}</button>
        ))}
      </div>
    );
  }
  return (
    <form className="card stack" onSubmit={send}>
      <h1 className="title">{picked.label}</h1>
      {picked.kind === 'accident' && <p className="warn">If anyone is hurt, call 112 first.</p>}
      <label className="field"><span>Anything control should know? (optional)</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {err && <p className="error" role="alert">{err}</p>}
      <button className="primary big" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send to control'}</button>
      <button className="link" type="button" onClick={() => setPicked(null)}>Back</button>
    </form>
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
              <p>{m.body}</p>
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
        <p className="meta">You can reply once someone in control has written to you. To raise something new, use Report.</p>
      )}
    </div>
  );
}

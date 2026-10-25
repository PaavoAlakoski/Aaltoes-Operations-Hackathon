// Live operations, woven into the other screens. Needs action gets "On the road
// now": who is on shift, the KPI strip and the incident queue. Each
// order page gets its car: where it is, its incidents, the agent's proposal
// and the conversation with the driver. Staff only; drivers use the driver app.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { delayPhrase, type Incident, type Vehicle } from '@bahn/shared';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { ProposalCard } from './ProposalCard';
import { InTimeBanner, InTimePill } from './InTime';
import { DealerChat } from './DealerChat';
import { LiveMap } from './LiveMap';
import { opsConfigured, useOps } from './ops';
import { byEmergency, calculateEmergencyScore } from './emergency';
import s from './live.module.css';

const KIND_WORD: Record<string, string> = {
  breakdown: 'Breakdown', accident: 'Accident', delay: 'Delay', car_not_ready: 'Car not ready', documents: 'Documents',
  ferry: 'Ferry', tracking_gap: 'No position', damage: 'Damage', other: 'Other',
};
const SOURCE_WORD = { driver: 'from the driver', control: 'from control', agent: 'from the agent', system: 'from the system' } as const;
const STATUS_WORD: Record<Vehicle['status'], string> = {
  waiting_pickup: 'Waiting for pickup', moving: 'On the road', on_ferry: 'On the ferry', stopped: 'Stopped',
  needs_check: 'Needs a check', delivered: 'Delivered', offline: 'No signal',
};

function minutesAgo(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

/** Where an incident is worked on: its car's order page. */
function orderPath(vehicle: Vehicle | undefined, incidentId?: string): string | null {
  if (!vehicle?.order_ref) return null;
  return `/orders/${vehicle.order_ref}${incidentId ? `?incident=${incidentId}` : ''}`;
}

// ---------------------------------------------------------------- Needs action

export function LiveNow() {
  const ops = useOps();
  // Signed out, there is nothing to show here: sign in is in the header (Account).
  if (!opsConfigured || ops.status === 'signed-out') return null;
  return (
    <section className={s.now} aria-labelledby="live-now">
      <div className={s.nowHead}>
        <h2 id="live-now" className={s.nowTitle}>On the road now</h2>
        {ops.status === 'ready' && ops.profile && ops.profile.role !== 'driver' && <ConnectionWarning />}
      </div>
      {ops.status === 'ready' && ops.profile && ops.profile.role !== 'driver' && <Kpis />}
      <LiveNowBody />
    </section>
  );
}

function LiveNowBody() {
  const ops = useOps();
  if (ops.status === 'error') return <ErrorState message={ops.error ?? 'Unknown error'} />;
  if (ops.status === 'loading' || !ops.profile) return <SkeletonRows rows={3} label="Loading live operations" />;
  if (ops.profile.role === 'driver') {
    return <Empty title="This is the control room.">Drivers use the driver app. <button type="button" className={s.textButton} onClick={ops.signOut}>Sign out</button></Empty>;
  }
  return <Room />;
}

/** Top right of the header: Sign in (opens a small form), or the signed-in name and Sign out. */
export function Account() {
  const ops = useOps();
  const { signIn } = ops;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!opsConfigured) return null;
  if (ops.status !== 'signed-out') {
    if (ops.status === 'loading') return <span className={s.account}>Signing in…</span>;
    return (
      <span className={s.account}>
        {ops.profile?.full_name && <span className={s.accountName}>{ops.profile.full_name}</span>}
        <button type="button" className={s.textButton} onClick={() => void ops.signOut()}>Sign out</button>
      </span>
    );
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await signIn(email, password);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className={s.account}>
      <button type="button" className={s.textButton} aria-expanded={open} onClick={() => setOpen((o) => !o)}>Sign in</button>
      {open && (
    <form className={s.accountPanel} onSubmit={submit} aria-label="Sign in">
      <p className={s.meta}>For staff: cars, drivers and incidents on the road.</p>
      <div className={s.accountFields}>
        <label className={s.field}>
          <span>Email</span>
          <input className={s.input} type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className={s.field}>
          <span>Password</span>
          <input className={s.input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button type="submit" className={s.primary} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </div>
      {err && <p className={s.error} role="alert">{err}</p>}
    </form>
      )}
    </span>
  );
}

function Room() {
  const ops = useOps();
  const { incidents, vehicles, proposals } = ops;

  const pendingByIncident = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of proposals) m.set(p.incidentId, (m.get(p.incidentId) ?? 0) + p.moves.filter((x) => x.status === 'pending').length);
    return m;
  }, [proposals]);
  // Only open incidents: a resolved one needs nobody, and its order page keeps the history.
  // Most urgent first; the top one is highlighted.
  const shown = useMemo(
    () => byEmergency(incidents.filter((i) => i.status !== 'resolved'),
      (i) => calculateEmergencyScore(i, { vehicle: vehicles.get(i.vehicle_id), pending: pendingByIncident.get(i.id) ?? 0 })),
    [incidents, vehicles, pendingByIncident],
  );

  return (
    <>
      <div className={s.grid}>
        <section className={s.queue} aria-label="Incidents">
          <div className={s.queueHead}>
            <h3 className={s.h2}>Incidents</h3>
          </div>
          {shown.length === 0 ? (
            <Empty title="Nothing open.">New incidents from drivers, the system and the agent appear here as they happen.</Empty>
          ) : (
            <ul className={s.list}>
              {shown.map((i, index) => (
                <IncidentRow key={i.id} incident={i} vehicle={vehicles.get(i.vehicle_id)} pending={pendingByIncident.get(i.id) ?? 0} top={index === 0} />
              ))}
            </ul>
          )}
          <div className={s.queueFoot}>
            <ResetDemo />
          </div>
        </section>
      </div>
    </>
  );
}

/** Puts the demo back to its starting point, after a second click. */
function ResetDemo() {
  const { resetDemo } = useOps();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const n = await resetDemo();
      setDone(`Demo reset: removed ${n.messages} messages, ${n.chat} chat messages, ${n.incidents} incidents and ${n.suggestions} agent proposals.`);
      setAsking(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!asking) {
    return (
      <>
        <button type="button" className={s.danger} onClick={() => { setAsking(true); setDone(null); }}>
          Reset demo
        </button>
        {done && <p className={s.meta} role="status">{done}</p>}
      </>
    );
  }
  return (
    <div className={s.confirm} role="alertdialog" aria-label="Reset demo">
      <p>Put the demo back to its starting point for everyone? Every message, chat and report sent while testing goes, with the agent's replies, proposals and bookings. Cars, drivers, travel plans and routes return to the original data. This can't be undone.</p>
      <div className={s.inline}>
        <button type="button" className={s.dangerSolid} onClick={() => void run()} disabled={busy}>
          {busy ? 'Resetting…' : 'Reset everything'}
        </button>
        <button type="button" className={s.textButton} onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
      </div>
      {err && <p className={s.error} role="alert">{err}</p>}
    </div>
  );
}

/** Silent while live updates flow; a short notice only when they stop. */
function ConnectionWarning() {
  const { live } = useOps();
  if (live !== 'offline') return null;
  return <p className={s.error} role="status">Live updates are down. It reconnects on its own; until then, reload to see changes.</p>;
}

function Kpis() {
  const { kpis, vehicles } = useOps();
  const moving = [...vehicles.values()].filter((v) => v.status === 'moving' || v.status === 'on_ferry').length;
  const ack = kpis?.avg_ack_seconds;
  const parts = [
    `${moving} cars on the road`,
    kpis?.on_time_pct != null && `${kpis.on_time_pct}% on time`,
    kpis?.open_incidents != null && `${kpis.open_incidents} open`,
    kpis?.pending_suggestions != null && `${kpis.pending_suggestions} to decide`,
    ack != null && `${ack < 60 ? `${ack} s` : `${Math.round(ack / 60)} min`} to acknowledge`,
  ].filter(Boolean);
  return <p className={s.kpis}>{parts.join(' · ')}</p>;
}

function IncidentRow({ incident: i, vehicle, pending, top }: { incident: Incident; vehicle: Vehicle | undefined; pending: number; top: boolean }) {
  const { online, profile } = useOps();
  const watchers = online.filter((p) => p.viewing_incident === i.id && p.user_id !== profile?.id);
  const to = orderPath(vehicle, i.id);
  const body = (
    <>
      <span className={s.sev} data-severity={i.severity} data-active={i.status !== 'resolved' || undefined} aria-label={`Severity ${i.severity}`} />
      <span className={s.rowMain}>
        <span className={s.rowTitle}>
          {KIND_WORD[i.kind] ?? i.kind} · {vehicle?.label ?? i.vehicle_id} <span className={`mono ${s.ref}`}>{vehicle?.order_ref}</span>
        </span>
        <span className={s.meta}>
          {i.status === 'open' ? 'Open' : i.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'} · {minutesAgo(i.created_at)}
          {pending > 0 && <> <strong className={s.decideBadge}>{pending} to decide</strong></>}
          {i.status !== 'resolved' && <> <InTimePill vehicle={vehicle} /></>}
          {watchers.length > 0 && <> · {watchers.map((w) => w.name.split(' ')[0]).join(', ')} looking</>}
        </span>
      </span>
    </>
  );
  return <li className={top ? s.topIncident : undefined}>{to ?<Link to={to} className={s.row} data-severity={i.severity}>{body}</Link> : <div className={s.row}>{body}</div>}</li>;
}

// --------------------------------------------------------------- Order page

/** The car behind this order, live. Renders nothing when there is none or nobody is signed in. */
export function OrderLive({ reference }: { reference: string }) {
  const ops = useOps();
  const [params, setParams] = useSearchParams();
  const vehicle = useMemo(
    () => [...ops.vehicles.values()].find((v) => v.order_ref?.toUpperCase() === reference.toUpperCase()),
    [ops.vehicles, reference],
  );
  const incidents = vehicle ? ops.incidents.filter((i) => i.vehicle_id === vehicle.id) : [];
  const asked = params.get('incident');
  const selected = incidents.find((i) => i.id === asked) ?? incidents.find((i) => i.status !== 'resolved') ?? null;

  // The car's route for the map. Asked again when its status changes, since
  // that can put it on another leg; any failure leaves the corridor line.
  const { loadItinerary } = ops;
  useEffect(() => {
    if (vehicle && ops.status === 'ready' && ops.profile && ops.profile.role !== 'driver') loadItinerary(vehicle.id).catch(() => {});
  }, [vehicle?.id, vehicle?.status, ops.status, ops.profile?.role, loadItinerary]);

  // Tell the rest of the room which incident this person is looking at.
  const { setViewing } = ops;
  useEffect(() => {
    setViewing(selected?.id ?? null);
    return () => setViewing(null);
  }, [selected?.id, setViewing]);

  if (!opsConfigured || ops.status !== 'ready' || !ops.profile || ops.profile.role === 'driver' || !vehicle) return null;

  const driver = ops.staff.find((p) => p.vehicle_id === vehicle.id && p.role === 'driver');
  const site = vehicle.pickup_site_id ? ops.sites.get(vehicle.pickup_site_id) : undefined;
  const corridor = ops.corridors.filter((c) => c.id === vehicle.corridor_id);
  const hasPosition = vehicle.lat != null && vehicle.lng != null;
  const focus = hasPosition ? { lat: vehicle.lat!, lng: vehicle.lng! } : site ? { lat: site.lat, lng: site.lng } : null;
  const pick = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('incident', id);
    setParams(next, { replace: true });
  };

  return (
    <section className={s.orderLive} aria-labelledby="order-live">
      <div className={s.nowHead}>
        <h2 id="order-live" className={s.nowTitle}>
          <span className={s.liveDot} data-live={ops.live} /> Live
        </h2>
        <p className={s.meta}>
          {STATUS_WORD[vehicle.status] ?? vehicle.status}
          {vehicle.status !== 'waiting_pickup' && <> · {delayPhrase(vehicle.delay_seconds)}</>}
          {driver && <> · {driver.full_name}</>}
          {vehicle.registration && <> · <span className="mono">{vehicle.registration}</span></>}
          {vehicle.last_seen_at && <> · position {minutesAgo(vehicle.last_seen_at)}</>}
        </p>
      </div>

      {focus ? (
        <LiveMap
          className={s.mapSmall}
          corridors={corridor}
          vehicles={[vehicle]}
          flagged={new Set(incidents.some((i) => i.status !== 'resolved') ? [vehicle.id] : [])}
          selectedVehicle={vehicle.id}
          onSelect={() => {}}
          focus={focus}
          site={site ? { lat: site.lat, lng: site.lng, name: site.name } : null}
          route={ops.itineraries.get(vehicle.id)?.legs ?? null}
        />
      ) : (
        <p className={s.meta}>No position yet.</p>
      )}
      {!hasPosition && focus && <p className={s.meta}>No position for the car yet; the ring is the pickup dealer.</p>}

      <InTimeBanner vehicle={vehicle} />
      <DealerChat vehicle={vehicle} />

      {incidents.length > 1 && (
        <ul className={s.tabs} aria-label="Incidents on this car">
          {incidents.map((i) => (
            <li key={i.id}>
              <button type="button" className={s.tab} aria-pressed={i.id === selected?.id} onClick={() => pick(i.id)}>
                <span className={s.sev} data-severity={i.severity} /> {KIND_WORD[i.kind] ?? i.kind} · {i.status === 'resolved' ? 'resolved' : minutesAgo(i.created_at)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <IncidentDetail incident={selected} vehicle={vehicle} />
      ) : (
        <div className={s.detailGrid}>
          <p className={s.meta}>No incident on this car. Anything the driver, the system or the agent raises shows here as it happens.</p>
          <Thread vehicle={vehicle} incident={null} />
        </div>
      )}
    </section>
  );
}

/**
 * What the agent did when there is no proposal: it handled the incident itself
 * (set the car's status, messaged the driver, or judged it one for a person),
 * or its run failed. Until either is recorded, it is still looking.
 */
function AgentOutcome({ incident: i }: { incident: Incident }) {
  const { agentNotes } = useOps();
  const note = agentNotes.find((n) => (n.details as { incident_id?: string } | null)?.incident_id === i.id);
  const d = (note?.details ?? {}) as { summary?: string; status?: string | null; notified?: boolean; error?: string };
  if (note?.action === 'agent.handled') {
    const urgent = /emergency|police|112|injur|ambulance/i.test(d.summary ?? '');
    return (
      <div className={s.outcome} data-tone={urgent ? 'urgent' : undefined} role={urgent ? 'alert' : undefined}>
        <p className={s.outcomeTitle}>{urgent ? 'The agent says this needs a person now' : 'The agent handled this without a proposal'}</p>
        {d.summary && <p>{d.summary}</p>}
        <p className={s.meta}>
          {d.status ? `Set the car to ${STATUS_WORD[d.status as Vehicle['status']]?.toLowerCase() ?? d.status}` : 'Car status unchanged'}
          {' · '}{d.notified ? 'messaged the driver' : 'did not message the driver'} · {minutesAgo(note.created_at)}
        </p>
      </div>
    );
  }
  if (note?.action === 'agent.triage_failed') {
    const limited = /429|rate limit/i.test(d.error ?? '');
    return (
      <div className={s.outcome} data-tone="urgent" role="alert">
        <p className={s.outcomeTitle}>The agent could not look into this</p>
        <p>
          {limited
            ? 'Too many incidents reached the model at once (its rate limit), so this one has no proposal. Handle it by hand.'
            : `Its run failed: ${(d.error ?? 'no reason recorded').slice(0, 240)}`}
        </p>
        <p className={s.meta}>{minutesAgo(note.created_at)}</p>
      </div>
    );
  }
  return (
    <Empty title={i.source === 'agent' ? 'Raised by the agent.' : 'The agent is looking into this.'}>
      Its proposal or what it decided appears here when it is ready, usually within half a minute.
    </Empty>
  );
}

function IncidentDetail({ incident: i, vehicle }: { incident: Incident; vehicle: Vehicle }) {
  const ops = useOps();
  const proposals = ops.proposals.filter((p) => p.incidentId === i.id);
  // A double recovery's two lanes need the full width; the conversation goes below.
  const wide = proposals.some((p) => p.moves.some((m) => ['reassign_driver', 'book_stay', 'offer_market_job'].includes(m.suggestion_type)));
  const name = (id: string | null) => ops.staff.find((p) => p.id === id)?.full_name;

  return (
    <article className={s.detail} aria-label="Incident">
      <header className={s.detailHead}>
        <div>
          <h3 className={s.h2}>{KIND_WORD[i.kind] ?? i.kind}</h3>
          <p className={s.meta}>
            {i.status === 'open' ? 'Open' : i.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'}
            {' · '}reported {minutesAgo(i.created_at)} {SOURCE_WORD[i.source]}
            {i.assigned_to && <> · with {name(i.assigned_to) ?? 'someone'}</>}
          </p>
          {i.description && <p className={s.description}>{i.description}</p>}
        </div>
      </header>

      <div className={s.detailGrid} data-wide={wide || undefined}>
        <div>
          {proposals.length === 0 ? (
            <AgentOutcome incident={i} />
          ) : (
            proposals.map((p) => (
              <ProposalCard
                key={p.groupId}
                proposal={p}
                canApproveStatus={ops.profile?.role === 'supervisor'}
                onDecide={ops.decide}
                timeZone={(vehicle.pickup_site_id && ops.sites.get(vehicle.pickup_site_id)?.timezone) || undefined}
                nameOf={name}
              />
            ))
          )}
        </div>
        <Thread vehicle={vehicle} incident={i} />
      </div>
    </article>
  );
}

/**
 * Who has driven this car, in order, and from when: a replacement driver
 * (an executed reassign_driver) starts a new driver's turn on the car.
 */
function turnsOn(ops: ReturnType<typeof useOps>, vehicle: Vehicle, current: string | null) {
  const carIncidents = new Set(ops.incidents.filter((i) => i.vehicle_id === vehicle.id).map((i) => i.id));
  const handovers = ops.proposals.flatMap((p) => p.moves)
    .filter((m) => m.suggestion_type === 'reassign_driver' && m.status === 'executed' && m.executed_at && carIncidents.has(m.incident_id))
    .map((m) => {
      const p = m.payload as { driver_id?: string; from_driver_id?: string };
      return { from: p.from_driver_id ?? null, to: p.driver_id ?? null, at: Date.parse(m.executed_at!) };
    })
    .sort((a, b) => a.at - b.at);
  const turns: { id: string; since: number }[] = [];
  const first = handovers[0]?.from ?? (handovers.length ? null : current);
  if (first) turns.push({ id: first, since: -Infinity });
  for (const h of handovers) if (h.to) turns.push({ id: h.to, since: h.at });
  return turns;
}

function Thread({ vehicle, incident }: { vehicle: Vehicle; incident: Incident | null }) {
  const ops = useOps();
  const [body, setBody] = useState('');
  const [toCorridor, setToCorridor] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const current = ops.staff.find((p) => p.vehicle_id === vehicle.id && p.role === 'driver')?.id ?? null;
  const turns = turnsOn(ops, vehicle, current);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked && turns.some((t) => t.id === picked) ? picked : current ?? turns.at(-1)?.id ?? null;
  const who = (id: string | null) => (id ? ops.staff.find((p) => p.id === id)?.full_name ?? 'Someone' : 'Agent');

  // Each driver sees their own conversation: what was written to or by them,
  // and what was sent to the car (or its corridor, about this car) while they had it.
  type Msg = (typeof ops.messages)[number];
  const toCar = (m: Msg) => m.to_vehicle === vehicle.id || Boolean(m.to_corridor && incident && m.incident_id === incident.id);
  const ownerOf = (m: Msg) => {
    const direct = turns.find((t) => t.id === m.to_user || t.id === m.from_user);
    if (direct) return direct.id;
    if (!toCar(m)) return null;
    const at = Date.parse(m.created_at);
    return turns.filter((t) => t.since <= at).at(-1)?.id ?? null;
  };
  // A car nobody drives yet just shows what was sent to it.
  const thread = ops.messages.filter((m) => (shown ? ownerOf(m) === shown : toCar(m))).slice(0, 20).reverse();
  const onCar = shown === current;

  async function send(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const incident_id = incident?.id ?? null;
    try {
      // A driver who has handed the car on is written to directly.
      await ops.send(!onCar && shown
        ? { to_user: shown, incident_id, body }
        : toCorridor
        ? { to_corridor: vehicle.corridor_id, incident_id, body }
        : { to_vehicle: vehicle.id, incident_id, body });
      setBody('');
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  }

  return (
    <section className={s.thread} aria-label="Messages">
      <h3 className={s.h3}>Messages{shown ? ` with ${who(shown)}` : ''}</h3>
      {turns.length > 1 && (
        <ul className={s.tabs} aria-label="Drivers on this car">
          {turns.map((t) => (
            <li key={t.id}>
              <button type="button" className={s.tab} aria-pressed={t.id === shown} onClick={() => setPicked(t.id)}>
                {who(t.id)} · {t.id === current ? 'on the car' : 'handed over'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {thread.length === 0 ? (
        <p className={s.meta}>No messages yet.</p>
      ) : (
        <ol className={s.messages}>
          {thread.map((m) => (
            <li key={m.id} data-mine={m.from_user === ops.profile?.id || undefined}>
              <span className={s.meta}>
                {who(m.from_user)}{m.to_corridor ? ' → whole corridor' : ''} · {minutesAgo(m.created_at)}{m.read_at ? ' · read' : ''}
              </span>
              <p>{m.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form className={s.compose} onSubmit={send}>
        <label className="visually-hidden" htmlFor="msg">Message</label>
        <textarea id="msg" className={s.input} rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`Write to ${shown ? who(shown) : 'the driver'}…`} required />
        <div className={s.inline}>
          {onCar && (
            <label className={s.toggle}>
              <input type="checkbox" checked={toCorridor} onChange={(e) => setToCorridor(e.target.checked)} /> Send to everyone on this corridor
            </label>
          )}
          <button type="submit" className={s.primary} disabled={!body.trim()}>Send</button>
        </div>
        {err && <p className={s.error} role="alert">{err}</p>}
      </form>
    </section>
  );
}

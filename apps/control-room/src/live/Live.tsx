// Live operations, woven into the other screens. Needs you gets "On the road
// now": who is on shift, the KPI strip and the incident queue. Each
// order page gets its car: where it is, its incidents, the agent's proposal
// and the conversation with the driver. Staff only; drivers use the driver app.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { delayPhrase, type Incident, type Vehicle } from '@bahn/shared';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { ProposalCard } from './ProposalCard';
import { InTimeBanner, InTimePill } from './InTime';
import { opsConfigured, useOps } from './ops';
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

// ---------------------------------------------------------------- Needs you

export function LiveNow() {
  const ops = useOps();
  if (!opsConfigured) return null;
  return (
    <section className={s.now} aria-labelledby="live-now">
      <div className={s.nowHead}>
        <h2 id="live-now" className={s.nowTitle}>On the road now</h2>
        {ops.status === 'ready' && ops.profile && ops.profile.role !== 'driver' && <OnShift />}
      </div>
      {ops.status === 'ready' && ops.profile && ops.profile.role !== 'driver' && <Kpis />}
      <LiveNowBody />
    </section>
  );
}

function LiveNowBody() {
  const ops = useOps();
  if (ops.status === 'signed-out') return <SignIn />;
  if (ops.status === 'error') return <ErrorState message={ops.error ?? 'Unknown error'} />;
  if (ops.status === 'loading' || !ops.profile) return <SkeletonRows rows={3} label="Loading live operations" />;
  if (ops.profile.role === 'driver') {
    return <Empty title="This is the control room.">Drivers use the driver app. <button type="button" className={s.textButton} onClick={ops.signOut}>Sign out</button></Empty>;
  }
  return <Room />;
}

function SignIn() {
  const { signIn } = useOps();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Signed out, the block is one quiet line, so the queue stays at the top.
  const [open, setOpen] = useState(false);
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
  if (!open) {
    return (
      <p className={s.signInPrompt}>
        Cars, drivers and incidents on the road, for staff.{' '}
        <button type="button" className={s.textButton} onClick={() => setOpen(true)}>Sign in</button>
      </p>
    );
  }
  return (
    <form className={s.signIn} onSubmit={submit}>
      <div className={s.signInFields}>
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
  );
}

function Room() {
  const ops = useOps();
  const { incidents, vehicles, proposals } = ops;
  const navigate = useNavigate();
  const [showResolved, setShowResolved] = useState(false);
  const [simErr, setSimErr] = useState<string | null>(null);

  const open = incidents.filter((i) => i.status !== 'resolved');
  const shown = showResolved ? incidents : open;
  const pendingByIncident = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of proposals) m.set(p.incidentId, (m.get(p.incidentId) ?? 0) + p.moves.filter((x) => x.status === 'pending').length);
    return m;
  }, [proposals]);

  async function simulate() {
    setSimErr(null);
    try {
      const row = await ops.simulateFerryJam();
      const to = orderPath(ops.vehicles.get(row.vehicle_id), row.id);
      if (to) navigate(to);
    } catch (e) {
      setSimErr(e instanceof Error ? e.message : String(e));
    }
  }

  // No incident yet: pickup-watch raises it once it sees the driver will be late.
  async function simulateTrain() {
    setSimErr(null);
    try {
      const { order_ref } = await ops.simulateTrainDelay();
      if (order_ref) navigate(`/orders/${order_ref}`);
    } catch (e) {
      setSimErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <div className={s.grid}>
        <section className={s.queue} aria-label="Incidents">
          <div className={s.queueHead}>
            <h3 className={s.h2}>Incidents</h3>
            <label className={s.toggle}>
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
            </label>
          </div>
          {shown.length === 0 ? (
            <Empty title="Nothing open.">New incidents from drivers, the system and the agent appear here as they happen.</Empty>
          ) : (
            <ul className={s.list}>
              {shown.map((i) => (
                <IncidentRow key={i.id} incident={i} vehicle={vehicles.get(i.vehicle_id)} pending={pendingByIncident.get(i.id) ?? 0} />
              ))}
            </ul>
          )}
          <div className={s.queueFoot}>
            <button type="button" className={s.button} onClick={simulate} title="Stage the Travemünde ferry scenario: a car stuck in a Stau, check-in closing">
              Simulate ferry traffic jam
            </button>
            <button type="button" className={s.button} onClick={simulateTrain} title="Stage the Munich pickup: the driver's ICE is 3 h late and the dealer hands keys over in person only">
              Simulate train delay
            </button>
            <ClearActivity />
          </div>
          {simErr && <p className={s.error} role="alert">{simErr}</p>}
        </section>
      </div>
    </>
  );
}

/** Deletes what was sent while testing, after a second click. */
function ClearActivity() {
  const { clearActivity } = useOps();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const n = await clearActivity();
      setDone(`Deleted ${n.messages} messages, ${n.incidents} incidents and ${n.suggestions} agent proposals.`);
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
          Delete all messages and requests
        </button>
        {done && <p className={s.meta} role="status">{done}</p>}
      </>
    );
  }
  return (
    <div className={s.confirm} role="alertdialog" aria-label="Delete all messages and requests">
      <p>Delete the messages and reports sent since the demo data was loaded, with the agent's replies and proposals, for everyone? The original data and automatic tracking alerts stay. This can't be undone.</p>
      <div className={s.inline}>
        <button type="button" className={s.dangerSolid} onClick={() => void run()} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete everything'}
        </button>
        <button type="button" className={s.textButton} onClick={() => setAsking(false)} disabled={busy}>Cancel</button>
      </div>
      {err && <p className={s.error} role="alert">{err}</p>}
    </div>
  );
}

function OnShift() {
  const { online, profile, live, signOut } = useOps();
  const others = online.filter((p) => p.user_id !== profile?.id);
  return (
    <span className={s.onShift}>
      <span className={s.liveDot} data-live={live} /> {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Not live'}
      {' · '}{profile?.full_name}
      {others.length > 0 && <> · with {others.map((p) => p.name.split(' ')[0]).join(', ')}</>}
      {' · '}<button type="button" className={s.textButton} onClick={signOut}>Sign out</button>
    </span>
  );
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

function IncidentRow({ incident: i, vehicle, pending }: { incident: Incident; vehicle: Vehicle | undefined; pending: number }) {
  const { online, profile } = useOps();
  const watchers = online.filter((p) => p.viewing_incident === i.id && p.user_id !== profile?.id);
  const to = orderPath(vehicle, i.id);
  const body = (
    <>
      <span className={s.sev} data-severity={i.severity} aria-label={`Severity ${i.severity}`} />
      <span className={s.rowMain}>
        <span className={s.rowTitle}>
          {KIND_WORD[i.kind] ?? i.kind} · {vehicle?.label ?? i.vehicle_id} <span className={`mono ${s.ref}`}>{vehicle?.order_ref}</span>
        </span>
        <span className={s.meta}>
          {i.status === 'open' ? 'Open' : i.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'} · {minutesAgo(i.created_at)}
          {pending > 0 && <> · <strong className={s.attention}>{pending} to decide</strong></>}
          {i.status !== 'resolved' && <> <InTimePill vehicle={vehicle} /></>}
          {watchers.length > 0 && <> · {watchers.map((w) => w.name.split(' ')[0]).join(', ')} looking</>}
        </span>
      </span>
    </>
  );
  return <li>{to ? <Link to={to} className={s.row} data-severity={i.severity}>{body}</Link> : <div className={s.row}>{body}</div>}</li>;
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

  // Tell the rest of the room which incident this person is looking at.
  const { setViewing } = ops;
  useEffect(() => {
    setViewing(selected?.id ?? null);
    return () => setViewing(null);
  }, [selected?.id, setViewing]);

  if (!opsConfigured || ops.status !== 'ready' || !ops.profile || ops.profile.role === 'driver' || !vehicle) return null;

  const driver = ops.staff.find((p) => p.vehicle_id === vehicle.id && p.role === 'driver');
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

      <InTimeBanner vehicle={vehicle} />

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
          <Thread vehicle={vehicle} incident={null} driverName={driver?.full_name} />
        </div>
      )}
    </section>
  );
}

function IncidentDetail({ incident: i, vehicle }: { incident: Incident; vehicle: Vehicle }) {
  const ops = useOps();
  const staff = ops.staff.filter((p) => p.role !== 'driver');
  const driver = ops.staff.find((p) => p.vehicle_id === vehicle.id && p.role === 'driver');
  const proposals = ops.proposals.filter((p) => p.incidentId === i.id);
  // A double recovery's two lanes need the full width; the conversation goes below.
  const wide = proposals.some((p) => p.moves.some((m) => ['reassign_driver', 'book_stay', 'offer_market_job'].includes(m.suggestion_type)));
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const name = (id: string | null) => ops.staff.find((p) => p.id === id)?.full_name;

  async function act(fn: () => Promise<void>) {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

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
        <div className={s.actions}>
          {i.status === 'open' && <button type="button" className={s.primary} onClick={() => act(() => ops.acknowledge(i.id))}>Acknowledge</button>}
          {i.status !== 'resolved' && (
            <>
              <label className={s.inline}>
                <span className="visually-hidden">Assign to</span>
                <select className={s.input} value={i.assigned_to ?? ''} onChange={(e) => act(() => ops.assign(i.id, e.target.value || null))}>
                  <option value="">Nobody</option>
                  {staff.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                </select>
              </label>
              <form className={s.inline} onSubmit={(e) => { e.preventDefault(); act(() => ops.resolve(i.id, note)); }}>
                <label className="visually-hidden" htmlFor="resolve-note">How it was resolved</label>
                <input id="resolve-note" className={s.input} placeholder="How was it resolved?" value={note} onChange={(e) => setNote(e.target.value)} />
                <button type="submit" className={s.button}>Resolve</button>
              </form>
            </>
          )}
        </div>
      </header>
      {err && <p className={s.error} role="alert">{err}</p>}

      <div className={s.detailGrid} data-wide={wide || undefined}>
        <div>
          {proposals.length === 0 ? (
            <Empty title={i.source === 'agent' ? 'Raised by the agent.' : 'The agent is looking into this.'}>
              Its proposal appears here when it is ready, usually within half a minute. If none comes, the audit log says why.
            </Empty>
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
        <Thread vehicle={vehicle} incident={i} driverName={driver?.full_name} />
      </div>
    </article>
  );
}

function Thread({ vehicle, incident, driverName }: { vehicle: Vehicle; incident: Incident | null; driverName?: string }) {
  const ops = useOps();
  const [body, setBody] = useState('');
  const [toCorridor, setToCorridor] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const driver = ops.staff.find((p) => p.vehicle_id === vehicle.id && p.role === 'driver');
  const thread = ops.messages
    .filter((m) => (incident && m.incident_id === incident.id) || m.to_vehicle === vehicle.id || (driver && (m.from_user === driver.id || m.to_user === driver.id)))
    .slice(0, 20)
    .reverse();
  const who = (id: string | null) => (id ? ops.staff.find((p) => p.id === id)?.full_name ?? 'Someone' : 'Agent');

  async function send(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    const incident_id = incident?.id ?? null;
    try {
      await ops.send(toCorridor
        ? { to_corridor: vehicle.corridor_id, incident_id, body }
        : { to_vehicle: vehicle.id, incident_id, body });
      setBody('');
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    }
  }

  return (
    <section className={s.thread} aria-label="Messages">
      <h3 className={s.h3}>Messages{driverName ? ` with ${driverName}` : ''}</h3>
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
        <textarea id="msg" className={s.input} rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write to the driver…" required />
        <div className={s.inline}>
          <label className={s.toggle}>
            <input type="checkbox" checked={toCorridor} onChange={(e) => setToCorridor(e.target.checked)} /> Send to everyone on this corridor
          </label>
          <button type="submit" className={s.primary} disabled={!body.trim()}>Send</button>
        </div>
        {err && <p className={s.error} role="alert">{err}</p>}
      </form>
    </section>
  );
}

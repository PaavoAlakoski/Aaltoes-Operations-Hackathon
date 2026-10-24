// The live operations room: who is on shift, the KPI strip, the map, the
// incident queue, and the open incident with the agent's proposal and the
// conversation with the driver. Staff only; drivers use the driver app.
import { useMemo, useState, type FormEvent } from 'react';
import { delayPhrase, type Incident, type Vehicle } from '@bahn/shared';
import { Page } from '../ui/Page';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { LiveMap } from './LiveMap';
import { ProposalCard } from './ProposalCard';
import { OpsProvider, opsConfigured, useOps } from './ops';
import s from './live.module.css';

export function LivePage() {
  return (
    <OpsProvider>
      <Gate />
    </OpsProvider>
  );
}

function Gate() {
  const ops = useOps();
  if (!opsConfigured) return <Page title="Live operations"><ErrorState message="The app has no Supabase settings. Copy .env.example to .env and fill it in." /></Page>;
  if (ops.status === 'signed-out') return <SignIn />;
  if (ops.status === 'error') return <Page title="Live operations"><ErrorState message={ops.error ?? 'Unknown error'} /></Page>;
  if (ops.status === 'loading' || !ops.profile) return <Page title="Live operations"><SkeletonRows rows={5} /></Page>;
  if (ops.profile.role === 'driver') {
    return (
      <Page title="Live operations">
        <Empty title="This is the control room.">Drivers use the driver app. <button type="button" className={s.textButton} onClick={ops.signOut}>Sign out</button></Empty>
      </Page>
    );
  }
  return <Room />;
}

function SignIn() {
  const { signIn } = useOps();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    <Page title="Live operations" meta="Sign in as a dispatcher or supervisor.">
      <form className={s.signIn} onSubmit={submit}>
        <label className={s.field}>
          <span>Email</span>
          <input className={s.input} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className={s.field}>
          <span>Password</span>
          <input className={s.input} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <p className={s.error} role="alert">{err}</p>}
        <button type="submit" className={s.primary} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </Page>
  );
}

const KIND_WORD: Record<string, string> = {
  breakdown: 'Breakdown', accident: 'Accident', delay: 'Delay', car_not_ready: 'Car not ready', documents: 'Documents',
  ferry: 'Ferry', tracking_gap: 'No position', damage: 'Damage', other: 'Other',
};
const SOURCE_WORD = { driver: 'from the driver', control: 'from control', agent: 'from the agent', system: 'from the system' } as const;

function minutesAgo(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

function Room() {
  const ops = useOps();
  const { incidents, vehicles, proposals, viewing, setViewing } = ops;
  const [showResolved, setShowResolved] = useState(false);
  const [simErr, setSimErr] = useState<string | null>(null);

  const open = incidents.filter((i) => i.status !== 'resolved');
  const shown = showResolved ? incidents : open;
  const flagged = useMemo(() => new Set(open.map((i) => i.vehicle_id)), [open]);
  const selected = incidents.find((i) => i.id === viewing) ?? null;
  const pendingByIncident = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of proposals) m.set(p.incidentId, (m.get(p.incidentId) ?? 0) + p.moves.filter((x) => x.status === 'pending').length);
    return m;
  }, [proposals]);

  function selectVehicle(vehicleId: string) {
    const latest = open.find((i) => i.vehicle_id === vehicleId);
    if (latest) setViewing(latest.id);
  }

  async function simulate() {
    setSimErr(null);
    try {
      const row = await ops.simulateFerryJam();
      setViewing(row.id);
    } catch (e) {
      setSimErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Page
      title="Live operations"
      width="order"
      meta={<OnShift />}
      actions={
        <>
          <button type="button" className={s.button} onClick={simulate} title="Stage the Travemünde ferry scenario: a car stuck in a Stau, check-in closing">
            Simulate ferry traffic jam
          </button>
          <button type="button" className={s.textButton} onClick={ops.signOut}>Sign out</button>
        </>
      }
    >
      {simErr && <p className={s.error} role="alert">{simErr}</p>}
      <KpiStrip />
      <div className={s.grid}>
        <LiveMap
          corridors={ops.corridors}
          vehicles={[...vehicles.values()]}
          flagged={flagged}
          selectedVehicle={selected?.vehicle_id ?? null}
          onSelect={selectVehicle}
        />
        <section className={s.queue} aria-label="Incidents">
          <div className={s.queueHead}>
            <h2 className={s.h2}>Incidents</h2>
            <label className={s.toggle}>
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
            </label>
          </div>
          {shown.length === 0 ? (
            <Empty title="Nothing open.">New incidents from drivers, the system and the agent appear here as they happen.</Empty>
          ) : (
            <ul className={s.list}>
              {shown.map((i) => (
                <IncidentRow key={i.id} incident={i} vehicle={vehicles.get(i.vehicle_id)} pending={pendingByIncident.get(i.id) ?? 0}
                  active={i.id === viewing} onOpen={() => setViewing(i.id === viewing ? null : i.id)} />
              ))}
            </ul>
          )}
        </section>
      </div>
      {selected ? <IncidentDetail incident={selected} /> : <Empty title="Open an incident to see the agent's proposal and talk to the driver." />}
    </Page>
  );
}

function OnShift() {
  const { online, profile, live } = useOps();
  const others = online.filter((p) => p.user_id !== profile?.id);
  return (
    <span className={s.onShift}>
      <span className={s.liveDot} data-live={live} /> {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Not live'}
      {' · '}Signed in as {profile?.full_name} ({profile?.role})
      {others.length > 0 && <> · Also on shift: {others.map((p) => p.name).join(', ')}</>}
    </span>
  );
}

function KpiStrip() {
  const { kpis, vehicles } = useOps();
  const moving = [...vehicles.values()].filter((v) => v.status === 'moving' || v.status === 'on_ferry').length;
  const ack = kpis?.avg_ack_seconds;
  return (
    <dl className={s.kpis}>
      <div><dt>On time</dt><dd>{kpis?.on_time_pct != null ? `${kpis.on_time_pct}%` : '–'}</dd></div>
      <div><dt>Cars on the road</dt><dd>{moving}</dd></div>
      <div><dt>Open incidents</dt><dd>{kpis?.open_incidents ?? '–'}</dd></div>
      <div><dt>Waiting for a decision</dt><dd>{kpis?.pending_suggestions ?? '–'}</dd></div>
      <div><dt>Avg time to acknowledge (24 h)</dt><dd>{ack == null ? '–' : ack < 60 ? `${ack} s` : `${Math.round(ack / 60)} min`}</dd></div>
    </dl>
  );
}

function IncidentRow({ incident: i, vehicle, pending, active, onOpen }: {
  incident: Incident; vehicle: Vehicle | undefined; pending: number; active: boolean; onOpen: () => void;
}) {
  const { online, profile } = useOps();
  const watchers = online.filter((p) => p.viewing_incident === i.id && p.user_id !== profile?.id);
  return (
    <li>
      <button type="button" className={s.row} data-active={active || undefined} data-severity={i.severity} onClick={onOpen} aria-expanded={active}>
        <span className={s.sev} data-severity={i.severity} aria-label={`Severity ${i.severity}`} />
        <span className={s.rowMain}>
          <span className={s.rowTitle}>
            {KIND_WORD[i.kind] ?? i.kind} · {vehicle?.label ?? i.vehicle_id} <span className="mono">{vehicle?.order_ref}</span>
          </span>
          <span className={s.meta}>
            {i.status === 'open' ? 'Open' : i.status === 'acknowledged' ? 'Acknowledged' : 'Resolved'} · {SOURCE_WORD[i.source]} · {minutesAgo(i.created_at)}
            {pending > 0 && <> · <strong className={s.attention}>{pending} to decide</strong></>}
            {watchers.length > 0 && <> · {watchers.map((w) => w.name.split(' ')[0]).join(', ')} looking</>}
          </span>
        </span>
      </button>
    </li>
  );
}

function IncidentDetail({ incident: i }: { incident: Incident }) {
  const ops = useOps();
  const vehicle = ops.vehicles.get(i.vehicle_id);
  const staff = ops.staff.filter((p) => p.role !== 'driver');
  const driver = ops.staff.find((p) => p.vehicle_id === i.vehicle_id && p.role === 'driver');
  const proposals = ops.proposals.filter((p) => p.incidentId === i.id);
  const thread = ops.messages
    .filter((m) => m.incident_id === i.id || m.to_vehicle === i.vehicle_id || (driver && (m.from_user === driver.id || m.to_user === driver.id)))
    .slice(0, 20)
    .reverse();
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
          <h2 className={s.h2}>{KIND_WORD[i.kind] ?? i.kind}: {vehicle?.label} <span className="mono">{vehicle?.order_ref}</span></h2>
          <p className={s.meta}>
            {driver ? `${driver.full_name} · ` : ''}{vehicle ? (vehicle.status === 'waiting_pickup' ? 'Waiting for pickup' : delayPhrase(vehicle.delay_seconds)) : ''}
            {' · '}Severity {i.severity} · reported {minutesAgo(i.created_at)} {SOURCE_WORD[i.source]}
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

      <div className={s.detailGrid}>
        <div>
          {proposals.length === 0 ? (
            <Empty title={i.source === 'agent' ? 'Raised by the agent.' : 'The agent is looking into this.'}>
              Its proposal appears here when it is ready, usually within half a minute. If none comes, the audit log says why.
            </Empty>
          ) : (
            proposals.map((p) => (
              <ProposalCard key={p.groupId} proposal={p} canApproveStatus={ops.profile?.role === 'supervisor'} onDecide={ops.decide} />
            ))
          )}
        </div>
        <Thread incident={i} thread={thread} driverName={driver?.full_name} />
      </div>
    </article>
  );
}

function Thread({ incident, thread, driverName }: { incident: Incident; thread: ReturnType<typeof useOps>['messages']; driverName?: string }) {
  const ops = useOps();
  const [body, setBody] = useState('');
  const [toCorridor, setToCorridor] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const vehicle = ops.vehicles.get(incident.vehicle_id);
  const who = (id: string | null) => (id ? ops.staff.find((p) => p.id === id)?.full_name ?? 'Someone' : 'Agent');

  async function send(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    try {
      await ops.send(toCorridor && vehicle
        ? { to_corridor: vehicle.corridor_id, incident_id: incident.id, body }
        : { to_vehicle: incident.vehicle_id, incident_id: incident.id, body });
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

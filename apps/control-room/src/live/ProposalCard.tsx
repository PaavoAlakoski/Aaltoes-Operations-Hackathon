// One agent proposal: what it found, then each move as a step that a person
// approves or rejects on its own. Nothing here acts; approving records the
// decision and the backend carries out that one move.
import { useState } from 'react';
import { euros, localTime, type Proposal, type Suggestion } from '@bahn/shared';
import { Icon } from '../ui/Icon';
import s from './live.module.css';

const MOVE_WORD: Record<string, string> = {
  rebook_ferry: 'Rebook ferry',
  book_hotel: 'Book hotel',
  message_vehicle: 'Message the driver',
  message_corridor: 'Message the corridor',
  set_vehicle_status: 'Change car status',
  escalate_incident: 'Escalate to supervisor',
  reassign_driver: 'Replacement driver',
  book_stay: 'Stay tonight',
  offer_market_job: 'Job for tomorrow',
};

// The double recovery: one lane saves the car, the other looks after the
// driver who could not make it. Shown large, side by side.
const CAR_MOVES = new Set(['reassign_driver']);
const DRIVER_MOVES = new Set(['book_stay', 'offer_market_job']);

type Facts = { headline: string; lines: string[]; link?: { href: string; label: string } };

/** The few numbers a dispatcher needs to decide a recovery move, from its payload. */
function facts(m: Suggestion, timeZone: string): Facts | null {
  const p = m.payload as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : null);
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : null);
  switch (m.suggestion_type) {
    case 'reassign_driver': {
      const arrives = str('arrives_at');
      return {
        headline: str('full_name') ?? 'Another driver',
        lines: [
          [num('drive_minutes') != null && `${num('drive_minutes')} min drive`, arrives && `at the ${p.to === 'car' ? 'car' : 'dealer'} ${localTime(arrives, timeZone)}`]
            .filter(Boolean).join(' · '),
          p.makes_closing === true ? 'Makes the key handover' : p.makes_closing === false ? 'Would miss the key handover' : '',
          p.from_driver_availability === 'off' ? 'The current driver is taken off work' : '',
        ].filter(Boolean),
      };
    }
    case 'book_stay': {
      const lat = num('lat');
      const lng = num('lng');
      return {
        headline: str('name') ?? 'Hotel',
        lines: [str('address') ?? '', `${num('nights') ?? 1} night · the driver pays and claims it back`].filter(Boolean),
        link: lat != null && lng != null ? { href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, label: 'Open in Google Maps' } : undefined,
      };
    }
    case 'offer_market_job':
      return {
        headline: `${str('label') ?? 'A car'} · ${str('order_ref') ?? ''}`,
        lines: [num('fee_cents') != null ? `Fee ${euros(num('fee_cents'))} · the driver decides` : 'The driver decides'],
      };
    default:
      return null;
  }
}

const STATUS_WORD: Record<Suggestion['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved, carrying out…',
  executed: 'Done',
  rejected: 'Rejected',
  failed: 'Failed',
};

/** The text the driver will get, if this move sends one. */
function driverText(m: Suggestion): string | null {
  const p = m.payload as Record<string, unknown>;
  return (typeof p.body === 'string' && p.body) || (typeof p.driver_message === 'string' && p.driver_message) || null;
}

export function ProposalCard({ proposal, canApproveStatus, onDecide, timeZone = 'Europe/Berlin', nameOf }: {
  proposal: Proposal;
  /** Car status changes need a supervisor. */
  canApproveStatus: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<void>;
  /** Where the times in a recovery happen. */
  timeZone?: string;
  nameOf?: (id: string | null) => string | undefined;
}) {
  const [showChecks, setShowChecks] = useState(false);
  const done = proposal.moves.every((m) => m.status === 'executed');
  const settled = proposal.moves.every((m) => m.status !== 'pending' && m.status !== 'approved');
  const carMoves = proposal.moves.filter((m) => CAR_MOVES.has(m.suggestion_type));
  const driverMoves = proposal.moves.filter((m) => DRIVER_MOVES.has(m.suggestion_type));
  const otherMoves = proposal.moves.filter((m) => !CAR_MOVES.has(m.suggestion_type) && !DRIVER_MOVES.has(m.suggestion_type));
  const recovery = carMoves.length + driverMoves.length > 0;
  const stranded = driverMoves.map((m) => (m.payload as Record<string, unknown>).driver_id as string | undefined).find(Boolean);
  const strandedName = nameOf?.(stranded ?? null)?.split(' ')[0];
  const number = (m: Suggestion) => proposal.moves.indexOf(m) + 1;
  // A substitute for a car already on the road takes over the drive, not a pickup.
  const takeover = carMoves.some((m) => (m.payload as Record<string, unknown>).to === 'car');

  return (
    <section className={s.proposal} aria-label="Agent proposal" data-done={done || undefined}>
      <header className={s.proposalHead}>
        <p className={s.eyebrow}>Agent proposal{proposal.moves.length > 1 ? ` · ${proposal.moves.length} moves` : ''}</p>
        <p className={s.summary}>{proposal.summary}</p>
        {proposal.checks.length > 0 && (
          <>
            <button type="button" className={s.textButton} aria-expanded={showChecks} onClick={() => setShowChecks((v) => !v)}>
              {showChecks ? 'Hide what the agent checked' : 'What the agent checked'}
            </button>
            {showChecks && (
              <ol className={s.checks}>
                {proposal.checks.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
            )}
          </>
        )}
      </header>

      {recovery && (
        // Three equal columns: the car's lane takes the first, the stranded driver's lane spans the other two.
        <div className={s.lanes} data-single={driverMoves.length === 0 || undefined}>
          {carMoves.length > 0 && (
            <section className={s.lane} data-lane="car" aria-label="The car">
              <h4 className={s.laneTitle}>{takeover ? 'The car: a new driver takes over' : 'The car: keep the pickup today'}</h4>
              <ol className={s.laneMoves}>
                {carMoves.map((m) => (
                  <Move key={m.id} move={m} n={number(m)} locked={false} onDecide={onDecide} facts={facts(m, timeZone)} />
                ))}
              </ol>
            </section>
          )}
          {driverMoves.length > 0 && (
            <section className={s.lane} data-lane="driver" aria-label="The driver">
              <h4 className={s.laneTitle}>{strandedName ?? 'The driver'}: tonight and tomorrow</h4>
              <ol className={s.laneMoves} data-pair={driverMoves.length > 1 || undefined}>
                {driverMoves.map((m) => (
                  <Move key={m.id} move={m} n={number(m)} locked={false} onDecide={onDecide} facts={facts(m, timeZone)} />
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      {(!recovery || otherMoves.length > 0) && (
        <ol className={s.moves}>
          {(recovery ? otherMoves : proposal.moves).map((m) => (
            <Move key={m.id} move={m} n={number(m)} locked={m.suggestion_type === 'set_vehicle_status' && !canApproveStatus} onDecide={onDecide} />
          ))}
        </ol>
      )}

      {(proposal.totalCents > 0 || done || settled) && (
        <footer className={s.proposalFoot}>
          {proposal.totalCents > 0 ? <span>Total {euros(proposal.totalCents)}</span> : <span />}
          {done ? <strong className={s.ok}>Recovered: every move is done.</strong> : settled ? <span>Decided</span> : null}
        </footer>
      )}
    </section>
  );
}

function Move({ move, n, locked, onDecide, facts, collapsible = false }: {
  move: Suggestion;
  n: number;
  locked: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<void>;
  /** Set for the big recovery cards. */
  facts?: Facts | null;
  /** Shut until clicked: the driver lane's two cards sit side by side. */
  collapsible?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const text = driverText(move);
  const kind = MOVE_WORD[move.suggestion_type];
  const title = move.title ?? kind ?? move.suggestion_type;

  async function run(decision: 'approve' | 'reject') {
    setBusy(true);
    setErr(null);
    try {
      await onDecide(move.id, decision, decision === 'reject' ? note : undefined);
      setRejecting(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const step = <span className={s.step} aria-hidden>{move.status === 'executed' ? '✓' : n}</span>;
  const bodyId = `move-${move.id}`;

  if (collapsible) {
    return (
      <li className={s.move} data-status={move.status} data-big={facts ? true : undefined} data-collapsible data-open={isExpanded || undefined}>
        <button type="button" className={s.moveToggle} aria-expanded={isExpanded} aria-controls={bodyId} onClick={() => setIsExpanded((v) => !v)}>
          {step}
          <span className={s.moveToggleTitle}>
            <span>{kind ?? title}</span>
            <span className={s.meta}>{STATUS_WORD[move.status]}</span>
          </span>
          <span className={s.chevron}><Icon name="down" /></span>
        </button>
        {isExpanded && <div id={bodyId} className={`${s.moveBody} ${s.reveal}`}>{body()}</div>}
      </li>
    );
  }

  return (
    <li className={s.move} data-status={move.status} data-big={facts ? true : undefined}>
      {step}
      <div className={s.moveBody}>{body()}</div>
    </li>
  );

  function body() {
    return (
      <>
        {facts && (
          <div className={s.bigFacts}>
            <p className={s.eyebrow}>{kind}</p>
            <p className={s.bigHeadline}>{facts.headline}</p>
            {facts.lines.map((l) => <p key={l} className={s.bigLine}>{l}</p>)}
            {facts.link && <a className={s.textButton} href={facts.link.href} target="_blank" rel="noreferrer">{facts.link.label}</a>}
          </div>
        )}
        <p className={s.moveTitle}>
          <span>{title}</span>
          {move.cost_cents ? <span className={s.cost}>{euros(move.cost_cents)}</span> : null}
        </p>
        <p className={s.meta}>{!facts && kind && kind !== title ? `${kind} · ` : ''}{STATUS_WORD[move.status]}</p>
        <p>{move.rationale}</p>
        {text && <blockquote className={s.quote}>{text}</blockquote>}
        {move.error && <p className={s.error}>{move.error}</p>}
        {move.decision_note && move.status === 'rejected' && <p className={s.meta}>Why not: {move.decision_note}</p>}

        {move.status === 'pending' && (
          <div className={s.actions}>
            {locked ? (
              <p className={s.meta}>Needs a supervisor to approve.</p>
            ) : rejecting ? (
              <form
                className={s.inline}
                onSubmit={(e) => {
                  e.preventDefault();
                  run('reject');
                }}
              >
                <label className="visually-hidden" htmlFor={`why-${move.id}`}>Why reject</label>
                <input id={`why-${move.id}`} className={s.input} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why not?" autoFocus required />
                <button type="submit" className={s.button} disabled={busy || !note.trim()}>Reject</button>
                <button type="button" className={s.textButton} onClick={() => setRejecting(false)}>Cancel</button>
              </form>
            ) : (
              <>
                <button type="button" className={s.primary} disabled={busy} onClick={() => run('approve')}>
                  Approve
                </button>
                <button type="button" className={s.button} disabled={busy} onClick={() => setRejecting(true)}>
                  Reject
                </button>
              </>
            )}
          </div>
        )}
        {err && <p className={s.error} role="alert">{err}</p>}
      </>
    );
  }
}

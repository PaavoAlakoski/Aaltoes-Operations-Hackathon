// One agent proposal: what it found, then each move as a step that a person
// approves or rejects on its own. Nothing here acts; approving records the
// decision and the backend carries out that one move.
import { useState } from 'react';
import { euros, type Proposal, type Suggestion } from '@bahn/shared';
import s from './live.module.css';

const MOVE_WORD: Record<string, string> = {
  rebook_ferry: 'Rebook ferry',
  book_hotel: 'Book hotel',
  message_vehicle: 'Message the driver',
  message_corridor: 'Message the corridor',
  set_vehicle_status: 'Change car status',
  escalate_incident: 'Escalate to supervisor',
};

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

export function ProposalCard({ proposal, canApproveStatus, onDecide }: {
  proposal: Proposal;
  /** Car status changes need a supervisor. */
  canApproveStatus: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<void>;
}) {
  const [showChecks, setShowChecks] = useState(false);
  const done = proposal.moves.every((m) => m.status === 'executed');
  const settled = proposal.moves.every((m) => m.status !== 'pending' && m.status !== 'approved');

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

      <ol className={s.moves}>
        {proposal.moves.map((m, i) => (
          <Move key={m.id} move={m} n={i + 1} locked={m.suggestion_type === 'set_vehicle_status' && !canApproveStatus} onDecide={onDecide} />
        ))}
      </ol>

      {(proposal.totalCents > 0 || done || settled) && (
        <footer className={s.proposalFoot}>
          {proposal.totalCents > 0 ? <span>Total {euros(proposal.totalCents)}</span> : <span />}
          {done ? <strong className={s.ok}>Recovered: every move is done.</strong> : settled ? <span>Decided</span> : null}
        </footer>
      )}
    </section>
  );
}

function Move({ move, n, locked, onDecide }: {
  move: Suggestion;
  n: number;
  locked: boolean;
  onDecide: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<void>;
}) {
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

  return (
    <li className={s.move} data-status={move.status}>
      <span className={s.step} aria-hidden>{move.status === 'executed' ? '✓' : n}</span>
      <div className={s.moveBody}>
        <p className={s.moveTitle}>
          <span>{title}</span>
          {move.cost_cents ? <span className={s.cost}>{euros(move.cost_cents)}</span> : null}
        </p>
        <p className={s.meta}>{kind && kind !== title ? `${kind} · ` : ''}{STATUS_WORD[move.status]}</p>
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
      </div>
    </li>
  );
}

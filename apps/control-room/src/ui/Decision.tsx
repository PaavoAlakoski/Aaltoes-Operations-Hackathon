// The decision flow for one item: pick an action, read exactly what will
// happen as a numbered list, add a note where one is needed, save. Once
// saved, the same list shows under "Decided by you" with an Undo.
import { useId, useRef, useState, useEffect } from 'react';
import type { AttentionItem } from '../domain/attention';
import type { ActionKind, Decision, OutcomeStep } from '../domain/types';
import { outcomeSteps, NEEDS_NOTE } from '../domain/outcomes';
import { actionLabel } from '../domain/labels';
import { formatShort } from '../domain/clock';
import { useStore } from '../data/store';
import { Icon } from './Icon';
import s from './Decision.module.css';

export function OutcomeList({ steps, label }: { steps: OutcomeStep[]; label?: string }) {
  return (
    <ol className={s.outcome} aria-label={label}>
      {steps.map((step, i) => (
        <li key={i} className={s.step} data-by={step.by}>
          <span className={s.num}>{i + 1}</span>
          <span>
            {step.text}
            {step.by === 'person' && <span className={s.onYou}> On you.</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

const CONFIRM_TITLE: Record<ActionKind, string> = {
  approve: 'If you approve', change: 'If you change it', reject: 'If you reject it', retry: 'If you retry',
  take: 'If you take it', already_sorted: 'If it’s already sorted', done: 'If you mark it handled',
  link: 'If you approve the match', not_this: 'If you reject the match',
};

const NOTE_PROMPT: Partial<Record<ActionKind, string>> = {
  change: 'What should the agent do instead?',
  reject: 'Why not?',
  done: 'How was it handled?',
  already_sorted: 'What was done, and where?',
};

export function DecisionControls({ item, compact = false }: { item: AttentionItem; compact?: boolean }) {
  const { world, decide } = useStore();
  const [picked, setPicked] = useState<ActionKind | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const noteId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const failed = item.status === 'FAILED';

  useEffect(() => {
    if (picked) panelRef.current?.querySelector<HTMLElement>('textarea, [data-save]')?.focus();
  }, [picked]);

  if (!world) return null;
  if (item.decision) return <Decided decision={item.decision} />;
  // No decision to make: the agent works this itself and brings a proposal when a yes or no is needed.
  if (item.actions.length === 0) {
    return <p className={s.agentOn}>The agent is on this. If it needs a decision, it brings you a proposal to approve or reject.</p>;
  }

  const needsNote = picked ? NEEDS_NOTE.has(picked) : false;
  const steps = picked ? outcomeSteps(item, picked, note, world) : [];
  // One primary per decision. In a compact list (folded items, inbox candidates)
  // several items sit side by side, so the choice is plain text; Save is the primary.
  const primary = compact ? null : item.actions[0];

  async function save() {
    if (!picked) return;
    if (needsNote && !note.trim()) {
      setError('Add a short note first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await decide(item.orderId, item.id, picked, note.trim(), outcomeSteps(item, picked, note, world!));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!picked) {
    return (
      <div className={s.actions} data-compact={compact || undefined}>
        {item.actions.map((a) => (
          <button
            key={a} type="button" className={a === primary ? s.primary : s.text}
            onClick={() => { setPicked(a); setNote(''); setError(null); }}
          >
            {actionLabel(a, failed)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={s.confirm} ref={panelRef}>
      <p className={s.confirmTitle}>{picked === 'take' && failed ? 'If you handle it yourself' : CONFIRM_TITLE[picked]}, this is what happens:</p>
      <OutcomeList steps={steps} label="What will happen" />
      {needsNote && (
        <div className={s.noteField}>
          <label htmlFor={noteId} className={s.noteLabel}>{NOTE_PROMPT[picked] ?? 'Note'}</label>
          <textarea
            id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={s.note}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(); if (e.key === 'Escape') setPicked(null); }}
          />
        </div>
      )}
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.actions}>
        <button type="button" className={s.primary} data-save onClick={() => void save()} disabled={saving}
          onKeyDown={(e) => { if (e.key === 'Escape') setPicked(null); }}>
          {saving ? 'Saving…' : `Save: ${actionLabel(picked, failed)}`}
        </button>
        <button type="button" className={s.text} onClick={() => setPicked(null)} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

export function Decided({ decision }: { decision: Decision }) {
  const { world, undo } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!world) return null;
  return (
    <div className={s.decided}>
      <p className={s.decidedTitle}>
        <Icon name="check" /> Decided by you · {actionLabel(decision.action)} · {formatShort(decision.decided_at, new Date().toISOString())}
      </p>
      {decision.note && <p className={s.decidedNote}>“{decision.note}”</p>}
      <OutcomeList steps={decision.effects} label="What happens" />
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.actions}>
        <button
          type="button" className={s.text} disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await undo(decision.id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
          }}
        >
          <Icon name="undo" /> Undo
        </button>
      </div>
    </div>
  );
}

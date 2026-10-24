// What agents may do: each agent's record, and how much each kind of action
// may happen without a yes. The two fixed rules are shown locked.
import { useState } from 'react';
import { useStore } from '../data/store';
import type { AutonomyRow } from '../data/api';
import { agentRecords, SCOPE_TEXT } from '../domain/agents';
import { AUTONOMY_KIND, AUTONOMY_LEVEL, humanize } from '../domain/labels';
import { Page } from '../ui/Page';
import { Icon } from '../ui/Icon';
import { ErrorState, SkeletonRows } from '../ui/states';
import s from './Agents.module.css';

const COLUMNS = [
  ['proposed', 'Proposed'],
  ['approved', 'Approved'],
  ['changed', 'Changed'],
  ['rejected', 'Rejected'],
  ['failed', 'Failed'],
  ['waiting', 'Waiting'],
] as const;

const LEVELS = Object.keys(AUTONOMY_LEVEL) as AutonomyRow['level'][];

export function Agents() {
  const { status, error, retry, world, decisions, autonomy } = useStore();
  if (status === 'error') return <Page title="What agents may do"><ErrorState message={error ?? ''} onRetry={retry} /></Page>;
  if (status === 'loading' || !world) return <Page title="What agents may do"><SkeletonRows rows={4} /></Page>;

  const records = agentRecords(world, decisions);
  const rows = autonomy.slice().sort((a, b) => Number(b.locked) - Number(a.locked) || a.action_kind.localeCompare(b.action_kind));

  return (
    <Page title="What agents may do" meta="Agents do the legwork. People make the judgement calls.">
      <section aria-labelledby="record">
        <h2 id="record" className={s.sectionTitle}>Their record</h2>
        <p className={s.meta}>From the recorded reviews in the snapshot, plus the decisions made here.</p>
        <ul className={s.agents}>
          {records.map((r) => (
            <li key={r.id} className={s.agent}>
              <div className={s.agentInfo}>
                <p className={s.agentName}>{r.title}</p>
                <p className={s.meta}>{SCOPE_TEXT[r.scope] ?? humanize(r.scope)}</p>
              </div>
              <dl className={s.numbers}>
                {COLUMNS.map(([k, label]) => (
                  <div key={k} className={s.number}>
                    <dt className={s.meta}>{label}</dt>
                    <dd className={s.value}>{r[k]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="autonomy" className={s.section}>
        <h2 id="autonomy" className={s.sectionTitle}>How far they may go</h2>
        <p className={s.meta}>Start with approvals. Give more freedom as an agent earns trust.</p>
        <ul className={s.levels}>
          {rows.map((row) => <AutonomyLine key={row.action_kind} row={row} />)}
        </ul>
      </section>
    </Page>
  );
}

function AutonomyLine({ row }: { row: AutonomyRow }) {
  const { setAutonomy } = useStore();
  const [error, setError] = useState<string | null>(null);
  const info = AUTONOMY_KIND[row.action_kind] ?? { title: humanize(row.action_kind), detail: '' };
  const name = `level-${row.action_kind}`;
  return (
    <li className={s.level}>
      <div className={s.levelInfo}>
        <p className={s.levelTitle}>
          {row.locked && <Icon name="lock" label="Fixed rule" />} {info.title}
        </p>
        <p className={s.meta}>{info.detail}{row.locked ? ' This rule is fixed.' : ''}</p>
        {error && <p className={s.error} role="alert">{error}</p>}
      </div>
      {row.locked ? (
        <p className={s.fixed}>{row.action_kind === 'customer_message' ? 'Never: drafts only' : AUTONOMY_LEVEL[row.level]}</p>
      ) : (
        <fieldset className={s.segmented}>
          <legend className="visually-hidden">{info.title}</legend>
          {LEVELS.map((l) => (
            <label key={l} className={s.option} data-on={row.level === l || undefined}>
              <input
                type="radio" name={name} value={l} checked={row.level === l}
                onChange={async () => {
                  setError(null);
                  try { await setAutonomy(row.action_kind, l); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
                }}
              />
              {AUTONOMY_LEVEL[l]}
            </label>
          ))}
        </fieldset>
      )}
    </li>
  );
}

// Small shared pieces: status dot, certainty word, times, owner names.
import type { ReactNode } from 'react';
import type { Certainty } from '../domain/evidence';
import type { Risk } from '../domain/attention';
import { formatTime, relative } from '../domain/clock';
import { CERTAINTY_HELP } from '../domain/labels';
import type { World } from '../domain/world';
import s from './bits.module.css';

export type Tone = 'red' | 'orange' | 'teal' | 'green' | 'none';

export function riskTone(risk: Risk): Tone {
  return risk >= 3 ? 'red' : risk === 2 ? 'orange' : 'none';
}

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={s.dot} data-tone={tone} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

const CERTAINTY_WORD: Record<Certainty, string> = {
  confirmed: 'Confirmed', stated: 'Stated', planned: 'Planned', quote: 'Quote', missing: 'Missing',
};

export function CertaintyWord({ c }: { c: Certainty }) {
  return (
    <span className={s.certainty} data-c={c} title={CERTAINTY_HELP[c]}>
      {CERTAINTY_WORD[c]}
    </span>
  );
}

/** A relative time ("in 2 h") with the exact time on hover and for screen readers. */
export function When({ iso, now, tz }: { iso: string; now: string; tz?: string }) {
  return (
    <time dateTime={iso} title={formatTime(iso, tz)}>
      {relative(iso, now)}
    </time>
  );
}

export function deskName(world: World, id: string | null | undefined): string {
  if (!id) return 'No owner';
  return world.operators.get(id)?.title ?? world.agents.get(id)?.title ?? 'Operations';
}

export function Ref({ children }: { children: ReactNode }) {
  return <span className={`mono ${s.ref}`}>{children}</span>;
}

export const SOURCE_WORD = { record: 'from the record', agent: 'from the agent', playbook: 'playbook' } as const;

export function SourceTag({ source }: { source: keyof typeof SOURCE_WORD }) {
  return <span className={s.source} data-source={source}>{SOURCE_WORD[source]}</span>;
}

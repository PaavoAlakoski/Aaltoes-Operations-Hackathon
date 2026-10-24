// Folding realtime changes into what the app already holds. Pure, so the
// tricky parts are tested: our own save arrives twice (from the RPC reply and
// from the stream) and must not show twice.
import type { Decision, RecordRow } from '../domain/types';
import type { AutonomyRow } from './api';

export interface Change<T> {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  /** The row after the change; empty on delete. */
  next: Partial<T>;
  /** For a delete, at least the primary key. */
  prev: Partial<T>;
}

export function applyDecisionChange(list: Decision[], c: Change<Decision>): Decision[] {
  if (c.type === 'DELETE') return list.filter((d) => d.id !== c.prev.id);
  const row = c.next as Decision;
  const rest = list.filter((d) => d.id !== row.id);
  return [row, ...rest].sort((a, b) => b.decided_at.localeCompare(a.decided_at));
}

export function applyAutonomyChange(list: AutonomyRow[], c: Change<AutonomyRow>): AutonomyRow[] {
  if (c.type === 'DELETE') return list.filter((a) => a.action_kind !== c.prev.action_kind);
  const row = c.next as AutonomyRow;
  return list.some((a) => a.action_kind === row.action_kind)
    ? list.map((a) => (a.action_kind === row.action_kind ? row : a))
    : [...list, row];
}

export const recordKey = (r: Pick<RecordRow, 'collection' | 'id'>) => `${r.collection}/${r.id}`;

/** Applies a change to the record index in place. Returns whether anything changed. */
export function applyRecordChange(rows: Map<string, RecordRow>, c: Change<RecordRow>): boolean {
  if (c.type === 'DELETE') {
    if (!c.prev.collection || !c.prev.id) return false;
    return rows.delete(recordKey(c.prev as RecordRow));
  }
  const row = c.next as RecordRow;
  rows.set(recordKey(row), row);
  return true;
}

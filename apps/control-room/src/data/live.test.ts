import { describe, expect, it } from 'vitest';
import { applyAutonomyChange, applyDecisionChange, applyRecordChange, recordKey } from './live';
import type { Decision, RecordRow } from '../domain/types';
import type { AutonomyRow } from './api';

const d = (id: string, at: string, over: Partial<Decision> = {}): Decision => ({
  id, order_id: 'ord-1', target_type: 'proposal', target_id: `t-${id}`, action: 'approve', note: null,
  decided_by: 'Shift operator', decided_at: at, effects: [], undone_at: null, ...over,
});

describe('decisions from the stream', () => {
  it('a decision someone else made appears, newest first', () => {
    const list = applyDecisionChange([d('a', '2026-10-24T10:00:00Z')], { type: 'INSERT', next: d('b', '2026-10-24T11:00:00Z'), prev: {} });
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
  });
  it('our own save, echoed back by the stream, shows once', () => {
    const mine = d('a', '2026-10-24T10:00:00Z');
    expect(applyDecisionChange([mine], { type: 'INSERT', next: mine, prev: {} })).toHaveLength(1);
  });
  it('an undo elsewhere replaces the row', () => {
    const list = applyDecisionChange([d('a', '2026-10-24T10:00:00Z')], {
      type: 'UPDATE', next: d('a', '2026-10-24T10:00:00Z', { undone_at: '2026-10-24T10:05:00Z' }), prev: { id: 'a' },
    });
    expect(list[0]!.undone_at).toBe('2026-10-24T10:05:00Z');
  });
  it('a delete removes it', () => {
    expect(applyDecisionChange([d('a', '2026-10-24T10:00:00Z')], { type: 'DELETE', next: {}, prev: { id: 'a' } })).toEqual([]);
  });
});

describe('autonomy from the stream', () => {
  it('replaces the level for that kind only', () => {
    const rows: AutonomyRow[] = [
      { action_kind: 'book_travel', level: 'ask_first', locked: false, updated_at: 'x' },
      { action_kind: 'approve_cost', level: 'ask_first', locked: false, updated_at: 'x' },
    ];
    const next = applyAutonomyChange(rows, { type: 'UPDATE', next: { ...rows[0]!, level: 'act_then_tell' }, prev: {} });
    expect(next.map((r) => r.level)).toEqual(['act_then_tell', 'ask_first']);
  });
});

describe('records from the stream', () => {
  it('upserts and deletes by collection and id', () => {
    const row: RecordRow = { collection: 'agent_proposals', id: 'p1', order_id: 'ord-1', data: { id: 'p1' } };
    const rows = new Map<string, RecordRow>();
    expect(applyRecordChange(rows, { type: 'INSERT', next: row, prev: {} })).toBe(true);
    expect(rows.get(recordKey(row))).toBe(row);
    expect(applyRecordChange(rows, { type: 'DELETE', next: {}, prev: { collection: 'agent_proposals', id: 'p1' } })).toBe(true);
    expect(rows.size).toBe(0);
  });
});

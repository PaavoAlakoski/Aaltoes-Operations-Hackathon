// The only module that talks to Supabase. Reads are paginated past the
// 1000-row limit; writes go through the three RPCs and nothing else.
import { createClient } from '@supabase/supabase-js';
import type { ActionKind, Decision, OutcomeStep, RecordRow } from '../domain/types';
import type { Change } from './live';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && key);
const db = configured ? createClient(url!, key!, { auth: { persistSession: false } }) : null;

function client() {
  if (!db) throw new Error('The app has no Supabase settings. Locally: copy .env.example to .env, fill it in and restart. On Vercel: add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY under Settings > Environment Variables and redeploy.');
  return db;
}

const PAGE = 1000;

export async function loadRecords(): Promise<RecordRow[]> {
  const rows: RecordRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client()
      .from('records')
      .select('collection,id,order_id,data')
      .order('collection')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data as RecordRow[]));
    if (data.length < PAGE) break;
  }
  if (rows.length === 0) throw new Error('The database is empty. Run `npm run seed` first.');
  return rows;
}

export async function loadDecisions(): Promise<Decision[]> {
  const { data, error } = await client().from('decisions').select('*').order('decided_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data as Decision[];
}

export interface AutonomyRow {
  action_kind: string;
  level: 'ask_first' | 'act_then_tell' | 'on_its_own';
  locked: boolean;
  updated_at: string;
}

export async function loadAutonomy(): Promise<AutonomyRow[]> {
  const { data, error } = await client().from('autonomy').select('*');
  if (error) throw new Error(error.message);
  return data as AutonomyRow[];
}

export async function decide(orderId: string, targetId: string, action: ActionKind, note: string, effects: OutcomeStep[]): Promise<Decision> {
  const { data, error } = await client().rpc('decide', {
    p_order_id: orderId, p_target_id: targetId, p_action: action, p_note: note || null, p_effects: effects,
  });
  if (error) throw new Error(error.message);
  return data as Decision;
}

export async function undoDecision(id: string): Promise<Decision> {
  const { data, error } = await client().rpc('undo_decision', { p_id: id });
  if (error) throw new Error(error.message);
  return data as Decision;
}

export async function setAutonomy(kind: string, level: AutonomyRow['level']): Promise<AutonomyRow> {
  const { data, error } = await client().rpc('set_autonomy', { p_kind: kind, p_level: level });
  if (error) throw new Error(error.message);
  return data as AutonomyRow;
}

/** Public URL of a packet attachment in the storage bucket. */
export function attachmentUrl(fileName: string): string {
  return `${url}/storage/v1/object/public/packet/${fileName}`;
}

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Streams changes to decisions, autonomy and records. Realtime applies the same
 * row-level security as reads, so the browser only sees rows it could select.
 */
export function subscribe(handlers: {
  decision: (c: Change<Decision>) => void;
  autonomy: (c: Change<AutonomyRow>) => void;
  record: (c: Change<RecordRow>) => void;
  status: (s: LiveStatus) => void;
}): () => void {
  const toChange = <T>(p: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: unknown; old: unknown }): Change<T> => ({
    type: p.eventType, next: (p.new ?? {}) as Partial<T>, prev: (p.old ?? {}) as Partial<T>,
  });
  const channel = client()
    .channel(`control-room-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'decisions' }, (p) => handlers.decision(toChange<Decision>(p)))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'autonomy' }, (p) => handlers.autonomy(toChange<AutonomyRow>(p)))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, (p) => handlers.record(toChange<RecordRow>(p)))
    .subscribe((s) => handlers.status(s === 'SUBSCRIBED' ? 'live' : s === 'CLOSED' || s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' ? 'offline' : 'connecting'));
  return () => {
    void client().removeChannel(channel);
  };
}

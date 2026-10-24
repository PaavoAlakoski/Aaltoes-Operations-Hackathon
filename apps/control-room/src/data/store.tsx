// Loads the snapshot once, then stays live: decisions, autonomy and records
// stream in from Supabase Realtime. Derives the triage. Components read from
// here; they never derive on their own.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from './api';
import { applyAutonomyChange, applyDecisionChange, applyRecordChange, recordKey } from './live';
import type { RecordRow } from '../domain/types';
import { buildWorld, type World } from '../domain/world';
import { triage, type Triage } from '../domain/triage';
import type { ActionKind, Decision, OutcomeStep } from '../domain/types';

type Status = 'loading' | 'ready' | 'error';

interface Store {
  status: Status;
  error: string | null;
  world: World | null;
  decisions: Decision[];
  autonomy: api.AutonomyRow[];
  triage: Triage | null;
  /** Whether changes from the database are streaming in. */
  live: api.LiveStatus;
  retry: () => void;
  decide: (orderId: string, targetId: string, action: ActionKind, note: string, effects: OutcomeStep[]) => Promise<Decision>;
  undo: (id: string) => Promise<void>;
  setAutonomy: (kind: string, level: api.AutonomyRow['level']) => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [autonomy, setAutonomyRows] = useState<api.AutonomyRow[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [live, setLive] = useState<api.LiveStatus>('connecting');
  // Every record by collection/id, so a streamed change can rebuild the world.
  const rows = useRef(new Map<string, RecordRow>());
  const rebuild = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    Promise.all([api.loadRecords(), api.loadDecisions(), api.loadAutonomy()])
      .then(([loaded, ds, au]) => {
        if (cancelled) return;
        rows.current = new Map(loaded.map((r) => [recordKey(r), r]));
        setWorld(buildWorld(loaded));
        setDecisions(ds);
        setAutonomyRows(au);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Stream changes once the first load is in.
  useEffect(() => {
    if (status !== 'ready') return;
    let wasOffline = false;
    const stop = api.subscribe({
      decision: (c) => setDecisions((prev) => applyDecisionChange(prev, c)),
      autonomy: (c) => setAutonomyRows((prev) => applyAutonomyChange(prev, c)),
      record: (c) => {
        if (!applyRecordChange(rows.current, c)) return;
        // A re-seed sends thousands of changes: rebuild once they settle.
        if (rebuild.current) clearTimeout(rebuild.current);
        rebuild.current = setTimeout(() => setWorld(buildWorld([...rows.current.values()])), 300);
      },
      status: (s) => {
        setLive(s);
        // Changes made while the connection was down were not streamed: catch up.
        if (s === 'offline') wasOffline = true;
        if (s === 'live' && wasOffline) {
          wasOffline = false;
          void Promise.all([api.loadDecisions(), api.loadAutonomy()]).then(([ds, au]) => {
            setDecisions(ds);
            setAutonomyRows(au);
          }).catch(() => undefined);
        }
      },
    });
    return () => {
      stop();
      if (rebuild.current) clearTimeout(rebuild.current);
    };
  }, [status]);

  const refreshDecisions = useCallback(async () => setDecisions(await api.loadDecisions()), []);

  const decide = useCallback<Store['decide']>(async (orderId, targetId, action, note, effects) => {
    try {
      const d = await api.decide(orderId, targetId, action, note, effects);
      setDecisions((prev) => applyDecisionChange(prev, { type: 'INSERT', next: d, prev: {} }));
      return d;
    } catch (e) {
      // Someone else may have decided it: show the current state.
      await refreshDecisions().catch(() => undefined);
      throw e;
    }
  }, [refreshDecisions]);

  const undo = useCallback(async (id: string) => {
    const d = await api.undoDecision(id);
    setDecisions((prev) => prev.map((x) => (x.id === id ? d : x)));
  }, []);

  const setAutonomy = useCallback(async (kind: string, level: api.AutonomyRow['level']) => {
    const row = await api.setAutonomy(kind, level);
    setAutonomyRows((prev) => prev.map((x) => (x.action_kind === kind ? row : x)));
  }, []);

  const t = useMemo(() => (world ? triage(world, decisions) : null), [world, decisions]);

  const value: Store = {
    status, error, world, decisions, autonomy, triage: t, live,
    retry: () => setAttempt((n) => n + 1), decide, undo, setAutonomy,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

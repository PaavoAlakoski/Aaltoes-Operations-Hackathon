// Loads the snapshot once, keeps decisions and autonomy fresh, and derives
// the triage. Components read from here; they never derive on their own.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as api from './api';
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

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    Promise.all([api.loadRecords(), api.loadDecisions(), api.loadAutonomy()])
      .then(([rows, ds, au]) => {
        if (cancelled) return;
        setWorld(buildWorld(rows));
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

  const refreshDecisions = useCallback(async () => setDecisions(await api.loadDecisions()), []);

  const decide = useCallback<Store['decide']>(async (orderId, targetId, action, note, effects) => {
    try {
      const d = await api.decide(orderId, targetId, action, note, effects);
      setDecisions((prev) => [d, ...prev]);
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
    status, error, world, decisions, autonomy, triage: t,
    retry: () => setAttempt((n) => n + 1), decide, undo, setAutonomy,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

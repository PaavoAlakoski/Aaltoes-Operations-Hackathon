// Home: only the orders that need a person, ranked by risk and the clock.
import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useStore } from '../data/store';
import { GROUP_LABEL, actionLabel } from '../domain/labels';
import { GROUP_ORDER } from '../domain/attention';
import { carName } from '../domain/caseView';
import { NEEDS_YOU_LIMIT, desks, matchesDesk, matchesSearch, type QueueRow } from '../domain/triage';
import { Page } from '../ui/Page';
import { Dot, Ref, clockPhrase, deskName, isOverdue, riskTone } from '../ui/bits';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Icon } from '../ui/Icon';
import { LiveNow } from '../live/Live';
import { useOps } from '../live/ops';
import s from './NeedsYou.module.css';

/** The last 12 hours of real time count as this shift. */
const SHIFT_MS = 12 * 3600_000;

export function NeedsYou() {
  const { status, error, retry, world, triage, decisions, undo } = useStore();
  const ops = useOps();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const desk = params.get('desk');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Without a search, only the most urgent few. A search or desk filter looks through every order
  // that needs a person, so nothing past the limit becomes unfindable.
  const filtering = Boolean(q || desk);
  const matching = useMemo(() => {
    if (!triage || !world) return [];
    return triage.rows.filter((r) => matchesDesk(r, desk) && matchesSearch(r, q, world));
  }, [triage, world, desk, q]);
  const visible = filtering ? matching : matching.slice(0, NEEDS_YOU_LIMIT);
  const hidden = matching.length - visible.length;

  // j/k move between rows, Enter opens, / searches.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-row]') ?? [])];
      if (!links.length) return;
      const i = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next = e.key === 'j' ? Math.min(links.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
      links[next]?.focus();
      links[next]?.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (status === 'error') return <Page title="Needs you"><ErrorState message={error ?? ''} onRetry={retry} /></Page>;

  const incidents = ops.incidents.filter((i) => i.status !== 'resolved').length;
  const meta = triage
    ? `${filtering ? `${visible.length} matching` : `The ${visible.length} most urgent`}${incidents ? ` · ${incidents} open incidents on the road` : ''}`
    : 'Loading the queue…';
  const now = world?.snapshotAt ?? '';
  const since = Date.now() - SHIFT_MS;
  const shift = decisions.filter((d) => !d.undone_at && Date.parse(d.decided_at) >= since);

  return (
    <Page title="Needs you" meta={meta}>
      <LiveNow />
      <div className={s.tools} role="search">
        <label className={s.search}>
          <Icon name="search" />
          <span className="visually-hidden">Search orders</span>
          <input
            ref={searchRef} type="search" placeholder="Search car, reference or customer" value={q}
            onChange={(e) => set('q', e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); if (e.key === 'Enter' && visible[0]) navigate(`/orders/${visible[0].reference}`); }}
          />
        </label>
        <label className={s.desk}>
          <span className="visually-hidden">Desk</span>
          <select value={desk ?? ''} onChange={(e) => set('desk', e.target.value || null)} disabled={!triage}>
            <option value="">All desks</option>
            {triage && world && desks(triage).map((d) => <option key={d} value={d}>{deskName(world, d)}</option>)}
            <option value="unowned">No owner yet</option>
          </select>
        </label>
      </div>

      {status === 'loading' || !triage || !world ? (
        <SkeletonRows rows={8} label="Loading the queue" />
      ) : visible.length === 0 ? (
        q || desk ? (
          <Empty title="Nothing matches.">
            <button type="button" className={s.clear} onClick={() => setParams({}, { replace: true })}>Clear the search and desk</button>
          </Empty>
        ) : (
          <Empty title="Nothing needs you right now.">The agents are on the rest. Quiet orders are still listed under All orders.</Empty>
        )
      ) : (
        <div ref={listRef}>
          {GROUP_ORDER.map((g) => {
            const rows = visible.filter((r) => r.group === g);
            if (!rows.length) return null;
            return (
              <section key={g} className={s.group} aria-labelledby={`g-${g}`}>
                <h2 id={`g-${g}`} className={s.groupTitle}>
                  {GROUP_LABEL[g]} <span className={s.groupCount}>{rows.length}</span>
                </h2>
                <ul className={s.rows}>
                  {rows.map((r) => <Row key={r.orderId} row={r} now={now} />)}
                </ul>
              </section>
            );
          })}
          {hidden > 0 && (
            <p className={s.overflow}>
              {hidden} more {hidden === 1 ? 'order needs' : 'orders need'} a person later.{' '}
              <Link to="/orders">See them under All orders</Link>
            </p>
          )}
        </div>
      )}

      {triage && world && shift.length > 0 && (
        <section className={s.shift} aria-labelledby="shift">
          <h2 id="shift" className={s.groupTitle}>Decided this shift <span className={s.groupCount}>{shift.length}</span></h2>
          <ul className={s.rows}>
            {shift.map((d) => {
              const b = world.bundles.get(d.order_id);
              const item = triage.allItems.get(d.order_id)?.find((i) => i.id === d.target_id);
              return (
                <li key={d.id} className={s.decidedRow}>
                  <Link to={`/orders/${b?.order.reference ?? ''}`} className={s.decidedLink}>
                    <span className={s.decidedRef}><Ref>{b?.order.reference}</Ref></span>
                    <span>{item?.title ?? 'Item'}</span>
                  </Link>
                  <span className={s.decidedAction}>{actionLabel(d.action, item?.status === 'FAILED')}</span>
                  <button type="button" className={s.undo} onClick={() => void undo(d.id)} aria-label={`Undo ${actionLabel(d.action)} on ${b?.order.reference}`}>
                    <Icon name="undo" /> Undo
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Page>
  );
}

function Row({ row, now }: { row: QueueRow; now: string }) {
  const { world } = useStore();
  if (!world) return null;
  const clock = clockPhrase(row.clock, now);
  const more = row.items.length - 1;
  return (
    <li>
      <Link to={`/orders/${row.reference}`} className={s.row} data-row>
        <span className={s.dotCell}><Dot tone={riskTone(row.risk)} label={row.risk >= 3 ? 'Critical' : row.risk === 2 ? 'High risk' : undefined} /></span>
        <span className={s.main}>
          <span className={s.car}>
            <span className={s.carName}>{carName(row.bundle)}</span> <Ref>{row.reference}</Ref>
          </span>
          <span className={s.reason}>{row.reason}{more > 0 && <span className={s.more}> · {more} more open</span>}</span>
        </span>
        <span className={s.side}>
          {clock && <span className={s.clock} data-overdue={isOverdue(row.clock, now) || undefined}>{clock}</span>}
          <span className={s.owner}>{deskName(world, row.owner)}</span>
        </span>
      </Link>
    </li>
  );
}

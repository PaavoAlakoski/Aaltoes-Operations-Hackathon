// Home: only the orders that need a person, ranked by risk and the clock.
import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router';
import { useStore } from '../data/store';
import { actionLabel } from '../domain/labels';
import { carName } from '../domain/caseView';
import { NEEDS_YOU_LIMIT, type QueueRow } from '../domain/triage';
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
  const listRef = useRef<HTMLDivElement>(null);

  // Only the most urgent few; everything else stays under All orders.
  const visible = useMemo(() => (triage ? triage.rows.slice(0, NEEDS_YOU_LIMIT) : []), [triage]);

  // j/k move between rows, Enter opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
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

  if (status === 'error') return <Page title="Needs action" titleHidden><ErrorState message={error ?? ''} onRetry={retry} /></Page>;

  const incidents = ops.incidents.filter((i) => i.status !== 'resolved').length;
  // No count line: the tab's badge carries the number. Open road incidents are still worth a line.
  const meta = incidents ? `${incidents} open incidents on the road` : undefined;
  const now = world?.snapshotAt ?? '';
  const since = Date.now() - SHIFT_MS;
  const shift = decisions.filter((d) => !d.undone_at && Date.parse(d.decided_at) >= since);

  return (
    <Page title="Needs action" titleHidden meta={meta}>
      <LiveNow />
      {status === 'loading' || !triage || !world ? (
        <SkeletonRows rows={8} label="Loading the queue" />
      ) : visible.length === 0 ? (
        <Empty title="Nothing needs action right now.">The agents are on the rest. Quiet orders are still listed under All orders.</Empty>
      ) : (
        // One list in urgency order (group, risk, clock); no group headings.
        <div ref={listRef}>
          <ul className={s.rows} aria-label="Orders that need action">
            {visible.map((r) => <Row key={r.orderId} row={r} now={now} />)}
          </ul>
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
  const open = row.items.length;
  return (
    <li>
      <Link to={`/orders/${row.reference}`} className={s.row} data-row>
        <span className={s.dotCell}><Dot tone={riskTone(row.risk)} label={row.risk >= 3 ? 'Critical' : row.risk === 2 ? 'High risk' : undefined} /></span>
        <span className={s.main}>
          <span className={s.car}>
            <span className={s.carName}>{carName(row.bundle)}</span> <Ref>{row.reference}</Ref>
          </span>
          <span className={s.reason}>{row.reason}</span>
        </span>
        <span className={s.open} aria-label={`${open} open ${open === 1 ? 'item' : 'items'}`}>
          <span className={s.openNumber}>{open}</span> open
        </span>
        <span className={s.side}>
          {clock && <span className={s.clock} data-overdue={isOverdue(row.clock, now) || undefined}>{clock}</span>}
          <span className={s.owner}>{deskName(world, row.owner)}</span>
        </span>
      </Link>
    </li>
  );
}

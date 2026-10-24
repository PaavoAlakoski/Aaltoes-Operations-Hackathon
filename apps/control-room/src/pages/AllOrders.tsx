// Every order, plain and sortable. For volume and lookup, not for deciding.
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useStore } from '../data/store';
import { header, carName } from '../domain/caseView';
import { STAGE_LABEL } from '../domain/labels';
import type { Stage } from '../domain/evidence';
import { isOpen } from '../domain/attention';
import { Page } from '../ui/Page';
import { Ref, clockPhrase } from '../ui/bits';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import s from './AllOrders.module.css';

type SortKey = 'reference' | 'car' | 'customer' | 'stage' | 'open' | 'clock';
const STAGES = Object.keys(STAGE_LABEL) as Stage[];
const COLS: [SortKey, string][] = [
  ['reference', 'Order'], ['car', 'Car'], ['customer', 'Customer'], ['stage', 'Stage'], ['open', 'Open'], ['clock', 'Next deadline'],
];

export function AllOrders() {
  const { status, error, retry, world, triage } = useStore();
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') as SortKey | null) ?? 'reference';
  const desc = params.get('dir') === 'desc';
  const stage = params.get('stage') as Stage | null;

  const rows = useMemo(() => {
    if (!world || !triage) return [];
    return world.orders.map((o) => {
      const b = world.bundles.get(o.id)!;
      const h = header(b, world);
      return { b, h, car: carName(b), open: (triage.allItems.get(o.id) ?? []).filter(isOpen).length };
    });
  }, [world, triage]);

  if (status === 'error') return <Page title="All orders"><ErrorState message={error ?? ''} onRetry={retry} /></Page>;
  if (status === 'loading' || !world) return <Page title="All orders"><SkeletonRows rows={10} /></Page>;

  const filtered = rows.filter((r) => !stage || r.h.stage === stage);
  const key = (r: (typeof rows)[number]): string | number => {
    switch (sort) {
      case 'reference': return r.h.reference;
      case 'car': return r.car;
      case 'customer': return r.h.customer;
      case 'stage': return STAGES.indexOf(r.h.stage);
      case 'open': return r.open;
      case 'clock': return r.h.deciding ? Date.parse(r.h.deciding.at) : Number.MAX_SAFE_INTEGER;
    }
  };
  const sorted = filtered.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
    return desc ? -c : c;
  });
  const counts = Object.fromEntries(STAGES.map((st) => [st, rows.filter((r) => r.h.stage === st).length]));

  const setSort = (k: SortKey) => {
    const next = new URLSearchParams(params);
    if (sort === k) next.set('dir', desc ? 'asc' : 'desc');
    else { next.set('sort', k); next.delete('dir'); }
    setParams(next, { replace: true });
  };

  return (
    <Page
      title="All orders"
      meta={`${rows.length} orders in the snapshot`}
      actions={
        <label>
          <span className="visually-hidden">Stage</span>
          <select className={s.select} value={stage ?? ''} onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('stage', e.target.value); else next.delete('stage');
            setParams(next, { replace: true });
          }}>
            <option value="">Every stage</option>
            {STAGES.map((st) => <option key={st} value={st}>{STAGE_LABEL[st]} ({counts[st]})</option>)}
          </select>
        </label>
      }
    >
      {sorted.length === 0 ? (
        <Empty title="No orders at this stage." />
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              {COLS.map(([k, label]) => (
                <th key={k} scope="col" aria-sort={sort === k ? (desc ? 'descending' : 'ascending') : 'none'}>
                  <button type="button" className={s.sort} onClick={() => setSort(k)}>
                    {label}{sort === k ? (desc ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(({ b, h, car, open }) => (
              <tr key={b.order.id}>
                <td data-label="Order"><Link to={`/orders/${h.reference}`} state={{ from: '/orders' }} className={s.ref}><Ref>{h.reference}</Ref></Link></td>
                <td data-label="Car"><span className={s.car}>{car}</span><span className={s.route}>{h.route}</span></td>
                <td data-label="Customer" className={s.meta}>{h.customer}</td>
                <td data-label="Stage">{h.stageLabel}</td>
                <td data-label="Open" className={s.num}>{open || <span className={s.meta}>none</span>}</td>
                <td data-label="Next deadline" className={s.meta}>{clockPhrase(h.deciding, world.snapshotAt) ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

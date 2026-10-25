// Every order, plain and sortable. For volume and lookup, not for deciding.
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useStore } from '../data/store';
import { header, carName } from '../domain/caseView';
import { STAGE_LABEL } from '../domain/labels';
import type { Stage } from '../domain/evidence';
import { isOpen } from '../domain/attention';
import { Page } from '../ui/Page';
import { Ref } from '../ui/bits';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import s from './AllOrders.module.css';

type SortKey = 'priority' | 'reference' | 'car' | 'customer' | 'stage';
const STAGES = Object.keys(STAGE_LABEL) as Stage[];
const COLS: [SortKey, string][] = [
  ['reference', 'Order'], ['car', 'Car'], ['customer', 'Customer'], ['stage', 'Stage'],
];
const SORT_KEYS: SortKey[] = ['priority', ...COLS.map(([k]) => k)];

export function AllOrders() {
  const { status, error, retry, world, triage } = useStore();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // Links to removed sort keys (the old Open and Next deadline columns) fall back to the default order.
  const asked = params.get('sort') as SortKey | null;
  const sort: SortKey = asked && SORT_KEYS.includes(asked) ? asked : 'priority';
  const desc = params.get('dir') === 'desc';

  const rows = useMemo(() => {
    if (!world || !triage) return [];
    return world.orders.map((o) => {
      const b = world.bundles.get(o.id)!;
      const h = header(b, world);
      return { b, h, car: carName(b), open: (triage.allItems.get(o.id) ?? []).filter(isOpen).length };
    });
  }, [world, triage]);

  if (status === 'error') return <Page title="All orders" titleHidden><ErrorState message={error ?? ''} onRetry={retry} /></Page>;
  if (status === 'loading' || !world) return <Page title="All orders" titleHidden><SkeletonRows rows={10} /></Page>;

  const key = (r: (typeof rows)[number]): string | number => {
    switch (sort) {
      // Default order: most open issues first (shown under Needs action), then by stage, delivered and cancelled last.
      case 'priority': return -r.open * 100 + STAGES.indexOf(r.h.stage);
      case 'reference': return r.h.reference;
      case 'car': return r.car;
      case 'customer': return r.h.customer;
      case 'stage': return STAGES.indexOf(r.h.stage);
    }
  };
  const sorted = rows.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb));
    return desc ? -c : c;
  });

  const setSort = (k: SortKey) => {
    const next = new URLSearchParams(params);
    if (sort === k) next.set('dir', desc ? 'asc' : 'desc');
    else { next.set('sort', k); next.delete('dir'); }
    setParams(next, { replace: true });
  };

  return (
    <Page title="All orders" titleHidden>
      {sorted.length === 0 ? (
        <Empty title="No orders in the snapshot." />
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
            {sorted.map(({ b, h, car }) => (
              // The whole row opens the order. The reference stays a real link for keyboards and new tabs.
              <tr
                key={b.order.id}
                className={s.clickable}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
                  navigate(`/orders/${h.reference}`);
                }}
              >
                <td data-label="Order"><Link to={`/orders/${h.reference}`} className={s.ref}><Ref>{h.reference}</Ref></Link></td>
                <td data-label="Car"><span className={s.car}>{car}</span><span className={s.route}>{h.route}</span></td>
                <td data-label="Customer" className={s.meta}>{h.customer}</td>
                <td data-label="Stage">{h.stageLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

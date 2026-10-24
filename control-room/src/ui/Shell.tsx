import { NavLink, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { useStore } from '../data/store';
import { formatTime } from '../domain/clock';
import s from './Shell.module.css';

const NAV = [
  { to: '/', label: 'Needs you', end: true },
  { to: '/orders', label: 'All orders', end: false },
  { to: '/inbox', label: 'Inbox', end: false },
  { to: '/agents', label: 'Agents', end: false },
];

const LIVE_WORD = { live: 'Live', connecting: 'Connecting…', offline: 'Not live' } as const;
const LIVE_HELP = {
  live: 'Decisions and changes from others appear as they happen.',
  connecting: 'Connecting to live updates.',
  offline: 'Live updates are down. Changes by others show after a reload; it reconnects on its own.',
} as const;

export function Shell() {
  const { world, triage, live } = useStore();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const needs = triage?.rows.length;
  const unmatched = world?.inboxThreads.filter((t) => t.status === 'OPEN' && t.linked_order_ids.length === 0 && t.link_state !== 'NO_ORDER_REQUIRED').length;

  return (
    <div className={s.app}>
      <a className={s.skip} href="#main">Skip to content</a>
      <header className={s.bar}>
        <div className={s.barInner}>
          <span className={s.brand}>Bahn <span className={s.brandSub}>Control room</span></span>
          <nav aria-label="Main" className={s.nav}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? `${s.link} ${s.active}` : s.link)}>
                {n.label}
                {n.to === '/' && needs ? <span className={s.count}>{needs}</span> : null}
                {n.to === '/inbox' && unmatched ? <span className={s.count}>{unmatched}</span> : null}
              </NavLink>
            ))}
          </nav>
          {world && (
            <span className={s.status}>
              <span className={s.live} data-live={live} aria-live="polite" title={LIVE_HELP[live]}>{LIVE_WORD[live]}</span>
              <span className={s.clock} title="The data is a frozen snapshot. Every relative time is measured from it.">
                Snapshot {formatTime(world.snapshotAt)}
              </span>
            </span>
          )}
        </div>
      </header>
      <main id="main" className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}

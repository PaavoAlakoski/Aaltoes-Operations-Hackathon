import { NavLink, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { useStore } from '../data/store';
import { NEEDS_YOU_LIMIT } from '../domain/triage';
import { Account } from '../live/Live';
import s from './Shell.module.css';

// The header: the two tabs in the middle, sign in on the right. Inbox and Agents still open from direct links.
const NAV = [
  // An order page is reached from every list, so no tab claims it.
  { to: '/orders', label: 'All orders', end: true },
  { to: '/', label: 'Needs action', end: true },
];

export function Shell() {
  const { triage } = useStore();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  // The badge counts what Needs action shows: the most urgent orders, never more than the limit.
  const needs = Math.min(triage?.rows.length ?? 0, NEEDS_YOU_LIMIT);

  return (
    <div className={s.app}>
      <a className={s.skip} href="#main">Skip to content</a>
      <header className={s.bar}>
        <div className={s.barInner}>
          <nav aria-label="Main" className={s.nav}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? `${s.link} ${s.active}` : s.link)}>
                {n.label}
                {n.to === '/' && needs > 0 && <span className={s.count} aria-label={`${needs} orders`}>{needs}</span>}
              </NavLink>
            ))}
          </nav>
          <div className={s.account}><Account /></div>
        </div>
      </header>
      <main id="main" className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}

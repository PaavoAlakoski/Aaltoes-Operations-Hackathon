import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { useOps } from '../live/ops';
import { Account } from '../live/Live';
import s from './Shell.module.css';

// The header: the logo on the left, the two tabs in the middle, sign in on the right. Inbox and Agents still open from direct links.
const NAV = [
  // An order page is reached from every list, so no tab claims it.
  { to: '/orders', label: 'All orders', end: true },
  { to: '/', label: 'Needs action', end: true },
];

export function Shell() {
  const ops = useOps();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  // The badge counts live incidents with a proposal waiting for Approve or Reject.
  const waiting = new Set(ops.proposals.filter((p) => p.moves.some((m) => m.status === 'pending')).map((p) => p.incidentId));
  const needs = ops.incidents.filter((i) => i.status !== 'resolved' && waiting.has(i.id)).length;

  return (
    <div className={s.app}>
      <a className={s.skip} href="#main">Skip to content</a>
      <header className={s.bar}>
        <div className={s.barInner}>
          <Link to="/" className={s.logo} aria-label="Bahn Express, home">
            Bahn <span className={s.logoSub}>Express</span>
          </Link>
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

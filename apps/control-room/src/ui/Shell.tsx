import { NavLink, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import s from './Shell.module.css';

// The header is the two tabs and nothing else. Inbox and Agents still open from direct links.
const NAV = [
  // An order page is reached from every list, so no tab claims it.
  { to: '/orders', label: 'All orders', end: true },
  { to: '/', label: 'Needs action', end: true },
];

export function Shell() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className={s.app}>
      <a className={s.skip} href="#main">Skip to content</a>
      <header className={s.bar}>
        <div className={s.barInner}>
          <nav aria-label="Main" className={s.nav}>
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? `${s.link} ${s.active}` : s.link)}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" className={s.main}>
        <Outlet />
      </main>
    </div>
  );
}

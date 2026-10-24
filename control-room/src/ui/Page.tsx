import type { ReactNode } from 'react';
import { useEffect } from 'react';
import s from './Page.module.css';

export function Page({ title, meta, width = 'list', children, actions }: {
  title: ReactNode;
  meta?: ReactNode;
  width?: 'list' | 'order';
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (typeof title === 'string') document.title = `${title} · Bahn control room`;
  }, [title]);
  return (
    <div className={s.page} data-width={width}>
      <header className={s.head}>
        <div>
          <h1 className={s.title}>{title}</h1>
          {meta && <p className={s.meta}>{meta}</p>}
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </header>
      {children}
    </div>
  );
}

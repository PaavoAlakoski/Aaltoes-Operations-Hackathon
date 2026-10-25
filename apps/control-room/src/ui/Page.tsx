import type { ReactNode } from 'react';
import { useEffect } from 'react';
import s from './Page.module.css';

export function Page({ title, titleHidden = false, meta, width = 'list', children, actions, back }: {
  title: ReactNode;
  /** The header tab already names the page: keep the heading for screen readers only. */
  titleHidden?: boolean;
  meta?: ReactNode;
  width?: 'list' | 'order';
  actions?: ReactNode;
  /** A link back to the list this page was opened from, shown above the title. */
  back?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    if (typeof title === 'string') document.title = `${title} · Bahn control room`;
  }, [title]);
  return (
    <div className={s.page} data-width={width}>
      {back && <div className={s.back}>{back}</div>}
      {titleHidden && !meta && !actions ? (
        // Nothing visible in the header: keep the heading for screen readers without the header's space.
        <h1 className="visually-hidden">{title}</h1>
      ) : (
        <header className={s.head}>
          <div>
            <h1 className={titleHidden ? 'visually-hidden' : s.title}>{title}</h1>
            {meta && <p className={s.meta}>{meta}</p>}
          </div>
          {actions && <div className={s.actions}>{actions}</div>}
        </header>
      )}
      {children}
    </div>
  );
}

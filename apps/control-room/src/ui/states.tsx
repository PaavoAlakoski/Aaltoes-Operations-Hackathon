// Designed loading, empty and error states. Skeletons take the real row shape.
import type { ReactNode } from 'react';
import s from './states.module.css';

export function SkeletonRows({ rows = 6, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} className={s.skeleton}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.row}>
          <span className={s.dot} />
          <div className={s.lines}>
            <span className={s.bar} style={{ width: `${38 + ((i * 17) % 30)}%` }} />
            <span className={s.bar} style={{ width: `${55 + ((i * 11) % 35)}%` }} />
            <span className={s.barMeta} style={{ width: `${30 + ((i * 13) % 25)}%` }} />
          </div>
          <span className={s.barMeta} style={{ width: 56 }} />
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <p className={s.emptyTitle}>{title}</p>
      {children && <p className={s.emptyText}>{children}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={s.empty} role="alert">
      <p className={s.emptyTitle}>We couldn’t load the control room.</p>
      <p className={s.emptyText}>{message}</p>
      {onRetry && (
        <button type="button" className={s.retry} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

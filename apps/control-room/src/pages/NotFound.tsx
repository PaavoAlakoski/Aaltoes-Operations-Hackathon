import { Link, useRouteError } from 'react-router';
import { Page } from '../ui/Page';
import { Empty } from '../ui/states';

export function NotFound() {
  return (
    <Page title="Not here">
      <Empty title="There is no page at this address.">
        <Link to="/">Back to Needs action</Link>
      </Empty>
    </Page>
  );
}

/** Shown if a screen throws. Plain words, a way back, and the error for whoever fixes it. */
export function Crashed() {
  const error = useRouteError();
  return (
    <div style={{ padding: '48px 16px' }}>
      <Page title="Something broke">
        <Empty title="This screen hit an error. Nothing you decided was lost.">
          <a href="/">Back to Needs action</a>
          <br />
          <span style={{ fontSize: 'var(--size-meta)' }}>{error instanceof Error ? error.message : String(error)}</span>
        </Empty>
      </Page>
    </div>
  );
}

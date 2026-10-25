// Home: the live decisions on the road. The agent works everything else; a person sees an
// incident here when its proposal waits for Approve or Reject (open the row to decide).
import { Page } from '../ui/Page';
import { Empty } from '../ui/states';
import { LiveNow } from '../live/Live';
import { opsConfigured, useOps } from '../live/ops';

export function NeedsYou() {
  const ops = useOps();
  const incidents = ops.incidents.filter((i) => i.status !== 'resolved').length;
  const meta = incidents ? `${incidents} open incidents on the road` : undefined;

  return (
    <Page title="Needs action" titleHidden meta={meta}>
      {!opsConfigured ? (
        <Empty title="Live operations are not set up here.">Add the Supabase settings to see cars, drivers and decisions on the road.</Empty>
      ) : ops.status === 'signed-out' ? (
        <Empty title="Sign in to see what needs a decision.">Use Sign in at the top right. Orders and their records are under All orders.</Empty>
      ) : (
        <LiveNow />
      )}
    </Page>
  );
}

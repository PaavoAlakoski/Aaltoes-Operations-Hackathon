// Support messages that arrived before anyone knew which order they are about.
// Candidates are guesses; a person decides which one, if any, is right.
import { Link } from 'react-router';
import { useStore } from '../data/store';
import type { InboxThread } from '../domain/types';
import { pickupSlot, type World } from '../domain/world';
import type { Triage } from '../domain/triage';
import { carName, routeLine } from '../domain/caseView';
import { STAGE_LABEL, categoryLabel, partyLabel, waitingOnLabel } from '../domain/labels';
import { deriveStage } from '../domain/evidence';
import { Page } from '../ui/Page';
import { Ref, When, deskName } from '../ui/bits';
import { DecisionControls } from '../ui/Decision';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import s from './Inbox.module.css';

export function Inbox() {
  const { status, error, retry, world, triage } = useStore();
  if (status === 'error') return <Page title="Inbox"><ErrorState message={error ?? ''} onRetry={retry} /></Page>;
  if (status === 'loading' || !world || !triage) return <Page title="Inbox" meta="Loading messages…"><SkeletonRows rows={3} /></Page>;

  const open = world.inboxThreads.filter((t) => t.status === 'OPEN');
  const unmatched = open.filter((t) => t.linked_order_ids.length === 0);
  const matched = open.filter((t) => t.linked_order_ids.length > 0);

  return (
    <Page title="Inbox" meta={`${unmatched.length} message${unmatched.length === 1 ? '' : 's'} not yet matched to an order`}>
      {unmatched.length === 0 ? (
        <Empty title="Every message is matched.">New support messages land here until someone links them to an order.</Empty>
      ) : (
        <ul className={s.threads}>
          {unmatched.map((t) => <Thread key={t.id} thread={t} world={world} triage={triage} />)}
        </ul>
      )}

      {matched.length > 0 && (
        <section className={s.section} aria-labelledby="matched">
          <h2 id="matched" className={s.sectionTitle}>Matched, still open <span className={s.count}>{matched.length}</span></h2>
          <ul className={s.matched}>
            {matched.map((t) => {
              const first = world.inboxMessages.get(t.id)?.find((m) => m.author_type !== 'operator');
              return (
                <li key={t.id} className={s.matchedRow}>
                  <span className={s.matchedText}>{first?.body}</span>
                  <span className={s.meta}>
                    {t.linked_order_ids.map((id) => {
                      const ref = world.bundles.get(id)?.order.reference;
                      return <Link key={id} to={`/orders/${ref}`} state={{ from: '/inbox' }}><Ref>{ref}</Ref></Link>;
                    })}
                    {t.waiting_on && ` · waiting on ${waitingOnLabel(t.waiting_on)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Page>
  );
}

function Thread({ thread: t, world, triage }: { thread: InboxThread; world: World; triage: Triage }) {
  const now = world.snapshotAt;
  const messages = world.inboxMessages.get(t.id) ?? [];
  const sender = t.counterparty_type === 'driver'
    ? world.drivers.get(t.counterparty_id)?.display_name
    : world.customers.get(t.counterparty_id)?.name;
  const linkDecision = t.candidate_order_ids
    .map((id) => triage.allItems.get(id)?.find((i) => i.id === `${t.id}#${id}`)?.decision)
    .find((d) => d?.action === 'link');

  return (
    <li className={s.thread}>
      <header className={s.threadHead}>
        <p>
          <span className={s.sender}>{sender ?? `A ${partyLabel(t.counterparty_type)}`}</span>
          <span className={s.meta}> · {categoryLabel(t.category)}</span>
        </p>
        <span className={s.meta}><When iso={t.opened_at} now={now} /></span>
      </header>

      <ol className={s.messages}>
        {messages.map((m) => (
          <li key={m.id} className={s.message} data-ours={m.author_type === 'operator' || undefined}>
            <p className={s.meta}>
              {m.author_type === 'operator' ? deskName(world, m.author_id) : sender ?? partyLabel(m.author_type)} · <When iso={m.authored_at} now={now} />
              {m.visibility === 'INTERNAL' && ' · internal note'}
            </p>
            <p>{m.body}</p>
          </li>
        ))}
      </ol>

      <div className={s.basis}>
        <p className={s.basisTitle}>{t.candidate_order_ids.length ? 'Why these might match' : 'Why it isn’t matched'}</p>
        <p>{t.candidate_basis}</p>
      </div>

      {t.candidate_order_ids.length === 0 ? (
        <p className={s.waiting}>
          {t.waiting_on ? `Waiting on ${waitingOnLabel(t.waiting_on)}.` : 'No candidate orders.'}
          {t.link_state === 'PENDING_IDENTITY' && ' Don’t share the other account’s order details while asking.'}
        </p>
      ) : (
        <ul className={s.candidates}>
          {t.candidate_order_ids.map((id) => {
            const b = world.bundles.get(id);
            const item = triage.allItems.get(id)?.find((i) => i.id === `${t.id}#${id}`);
            if (!b) return null;
            const slot = pickupSlot(b);
            const driver = b.assignments.find((a) => a.status === 'ASSIGNED' || a.status === 'IN_PROGRESS');
            const ruledOut = linkDecision && item?.decision?.id === linkDecision.id && linkDecision.target_id !== item.id;
            return (
              <li key={id} className={s.candidate}>
                <div className={s.candidateInfo}>
                  <p>
                    <Link to={`/orders/${b.order.reference}`} state={{ from: '/inbox' }} className={s.candidateLink}>{carName(b)}</Link> <Ref>{b.order.reference}</Ref>
                  </p>
                  <p className={s.meta}>
                    {routeLine(b, world)} · {STAGE_LABEL[deriveStage(b)]}
                    {driver && ` · ${world.drivers.get(driver.driver_id)?.display_name ?? 'driver'}`}
                    {slot && <> · pickup <When iso={slot.start_at} now={now} tz={slot.timezone} /></>}
                  </p>
                </div>
                <div className={s.candidateActions}>
                  {ruledOut ? <p className={s.meta}>Ruled out: the message was linked to another order.</p> : item && <DecisionControls item={item} compact />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

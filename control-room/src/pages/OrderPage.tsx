// One order, one decision: what happened, what the agent found or proposes,
// the evidence, and what happens if you approve, change or reject it.
import { useEffect, useMemo, useState, useId } from 'react';
import { Link, useParams } from 'react-router';
import { useStore } from '../data/store';
import { attachmentUrl } from '../data/api';
import { caseView, WHO_LABEL, type TimelineEntry, type Who } from '../domain/caseView';
import type { AttentionItem } from '../domain/attention';
import type { Fact } from '../domain/evidence';
import { evidenceLine } from '../domain/evidenceRefs';
import { payloadSteps, rechecksBeforeActing, autonomyKinds } from '../domain/proposals';
import { AUTONOMY_KIND, AUTONOMY_LEVEL, alertStatusLabel, proposalStatusLabel, humanize } from '../domain/labels';
import { formatShort, formatTime } from '../domain/clock';
import type { World } from '../domain/world';
import { Page } from '../ui/Page';
import { CertaintyWord, Dot, Ref, SourceTag, When, clockPhrase, deskName, riskTone, isOverdue } from '../ui/bits';
import { DecisionControls, OutcomeList } from '../ui/Decision';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Icon } from '../ui/Icon';
import s from './OrderPage.module.css';

export function OrderPage() {
  const { ref = '' } = useParams();
  const { status, error, retry, world, triage, decisions } = useStore();

  const bundle = world?.byReference.get(ref.toUpperCase());
  const view = useMemo(() => {
    if (!world || !triage || !bundle) return null;
    return caseView(bundle, world, triage.allItems.get(bundle.order.id) ?? [], decisions);
  }, [world, triage, bundle, decisions]);

  // The item you are deciding stays in the lead spot after you save, showing
  // "Decided by you" and an undo, until you leave the order. Without this the
  // next item would slide into its place mid-decision.
  const [pinned, setPinned] = useState<{ ref: string; id: string } | null>(null);
  const pinnedId = pinned?.ref === ref ? pinned.id : view?.lead?.id ?? null;
  useEffect(() => {
    if (view?.lead && pinned?.ref !== ref) setPinned({ ref, id: view.lead.id });
  }, [ref, view, pinned]);
  const all = view ? [...(view.lead ? [view.lead] : []), ...view.others, ...view.decided] : [];
  const lead = all.find((i) => i.id === pinnedId) ?? view?.lead ?? null;
  const open = view ? [...(view.lead ? [view.lead] : []), ...view.others] : [];
  const others = open.filter((i) => i.id !== lead?.id);
  const decidedOthers = view ? view.decided.filter((i) => i.id !== lead?.id) : [];

  if (status === 'error') return <Page title={ref} width="order"><ErrorState message={error ?? ''} onRetry={retry} /></Page>;
  if (status === 'loading' || !world) {
    return (
      <Page title={ref} width="order" meta="Loading the order…">
        <SkeletonRows rows={4} label="Loading the order" />
      </Page>
    );
  }
  if (!bundle || !view) {
    return (
      <Page title="Order not found" width="list">
        <Empty title={`There is no order ${ref} in this snapshot.`}><Link to="/orders">See all orders</Link></Empty>
      </Page>
    );
  }

  const now = world.snapshotAt;
  const h = view.header;
  const deciding = clockPhrase(h.deciding, now);

  return (
    <Page
      width="order"
      title={h.car}
      meta={
        <span className={s.headMeta}>
          <Ref>{h.reference}</Ref>
          <span>{h.route}</span>
          <span>{h.customer}</span>
          <span>{h.stageLabel}</span>
        </span>
      }
      actions={deciding ? (
        <span className={s.deciding} data-overdue={isOverdue(h.deciding, now) || undefined}>
          {deciding}
          {h.deciding && <span className={s.decidingAt}>{formatTime(h.deciding.at)}</span>}
        </span>
      ) : undefined}
    >
      <Link to="/" className={s.back}><Icon name="back" /> Needs you</Link>
      <p className={s.headline}>{view.headline}</p>

      <div className={s.grid}>
        <div className={s.left}>
          {lead ? <Lead key={lead.id} item={lead} world={world} /> : <QuietNote />}

          {others.length > 0 && (
            <section className={s.section} aria-labelledby="also">
              <h2 id="also" className={s.sectionTitle}>Also open <span className={s.count}>{others.length}</span></h2>
              <ul className={s.folded}>
                {others.map((i) => <Folded key={i.id} item={i} world={world} />)}
              </ul>
            </section>
          )}

          {decidedOthers.length > 0 && (
            <section className={s.section} aria-labelledby="decided">
              <h2 id="decided" className={s.sectionTitle}>Decided by you <span className={s.count}>{decidedOthers.length}</span></h2>
              <ul className={s.folded}>
                {decidedOthers.map((i) => <Folded key={i.id} item={i} world={world} />)}
              </ul>
            </section>
          )}

        </div>

        <div className={s.history}>
          <Timeline entries={view.timeline} now={now} />
          <AllRecords rows={bundle.raw} />
        </div>

        <aside className={s.right} aria-label="Facts">
          <h2 className="visually-hidden">Facts</h2>
          {view.facts.map((sec) => (
            <section key={sec.title} className={s.factSection}>
              <h2 className={s.sectionTitle}>{sec.title}</h2>
              <dl className={s.facts}>
                {sec.facts.map((f, i) => <FactRow key={i} fact={f} now={now} />)}
              </dl>
            </section>
          ))}
          {bundle.attachments.length > 0 && (
            <section className={s.factSection}>
              <h2 className={s.sectionTitle}>Files</h2>
              <ul className={s.files}>
                {bundle.attachments.map((a) => (
                  <li key={a.id}>
                    <a href={attachmentUrl(a.file_name)} target="_blank" rel="noreferrer" className={s.file}>
                      <Icon name="file" />
                      <span>{humanize(a.kind)}</span>
                    </a>
                    {a.captured_at && <span className={s.meta}> <When iso={a.captured_at} now={now} /></span>}
                  </li>
                ))}
              </ul>
              <p className={s.meta}>A file shows what was submitted, not what it proves.</p>
            </section>
          )}
        </aside>
      </div>
    </Page>
  );
}

function QuietNote() {
  return (
    <div className={s.quiet}>
      <p className={s.leadTitle}>Nothing needs you on this order.</p>
      <p className={s.meta}>No open alert, incident, follow-up, thread or agent proposal. That is not the same as verified: the facts on the right show what has actually been checked.</p>
    </div>
  );
}

function kicker(item: AttentionItem, world: World): string {
  const now = world.snapshotAt;
  const when = item.raisedAt ? ` · ${formatShort(item.raisedAt, now)}` : '';
  switch (item.kind) {
    case 'proposal': return `Agent proposal · ${proposalStatusLabel(item.status ?? '')}${when}`;
    case 'alert': return `Signal · ${alertStatusLabel(item.status ?? '')}${when}`;
    case 'incident': return `Incident${when}`;
    case 'work_item': return `Follow-up${when}`;
    case 'conversation': return `Thread${when}`;
    case 'custody': return 'Keys and papers';
    case 'inbox': case 'inbox_candidate': return `Support inbox${when}`;
    case 'pickup_check': return 'Check before pickup';
    case 'silent_driver': return `Tracking${when}`;
    case 'claim': return `Statement${when}`;
  }
}

function Lead({ item, world }: { item: AttentionItem; world: World }) {
  const now = world.snapshotAt;
  const p = item.proposal;
  const clock = clockPhrase(item.clock, now);
  return (
    <article className={s.lead} aria-labelledby="lead-title">
      <p className={s.kicker}><Dot tone={p ? 'teal' : riskTone(item.risk)} /> {kicker(item, world)}</p>
      <h2 id="lead-title" className={s.leadTitle}>{item.title}</h2>
      {item.detail && (
        <p className={s.detail}>
          {item.detail}
          <span className={s.meta}> — {p ? (p.status === 'FAILED' ? 'the attempt’s error' : 'the agent’s reasoning') : 'from the record'}</span>
        </p>
      )}

      {p && p.status !== 'FAILED' && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>{p.status === 'PENDING_REVIEW' ? 'If you approve, the agent' : 'The agent was approved to'}</h3>
          <OutcomeList steps={payloadSteps(p, world)} />
          {rechecksBeforeActing(p) && <p className={s.meta}>It re-checks the order before acting.</p>}
          <p className={s.meta}>{autonomyLine(p, world)}</p>
        </div>
      )}
      {p && p.status === 'FAILED' && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>What was attempted</h3>
          <p>{p.summary}</p>
          <p className={s.meta}>No change is recorded from this attempt. The proposal text alone does not mean anything was booked.</p>
        </div>
      )}

      {p && p.evidence_refs.length > 0 && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>What it is based on</h3>
          <dl className={s.facts}>
            {p.evidence_refs.map((r) => <FactRow key={r.id} fact={evidenceLine(r, item.orderId, world)} now={now} />)}
          </dl>
        </div>
      )}

      {!p && (
        <div className={s.block}>
          <h3 className={s.blockTitle}>Next step</h3>
          <p>{item.next.text} <SourceTag source={item.next.source} /></p>
          <p className={s.meta}>
            {[clock, item.owner ? deskName(world, item.owner) : 'No owner yet'].filter(Boolean).join(' · ')}
          </p>
        </div>
      )}

      <div className={s.decide}>
        <DecisionControls key={item.id} item={item} />
      </div>
    </article>
  );
}

function autonomyLine(p: NonNullable<AttentionItem['proposal']>, world: World): string {
  void world;
  const kinds = autonomyKinds(p);
  const strict = kinds.find((k) => k !== 'read_and_ask') ?? kinds[0]!;
  const info = AUTONOMY_KIND[strict];
  if (strict === 'read_and_ask') return 'Reading and asking need no yes; it still waits for you because the proposal holds the order.';
  if (strict === 'customer_message') return 'Anything for a customer is drafted for you. Nothing reaches them until you send it.';
  return `${info?.title ?? 'This action'}: ${AUTONOMY_LEVEL.ask_first.toLowerCase()}, so it waits for you.`;
}

function Folded({ item, world }: { item: AttentionItem; world: World }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const now = world.snapshotAt;
  const clock = clockPhrase(item.clock, now);
  return (
    <li className={s.foldedItem}>
      <button type="button" className={s.foldedHead} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Dot tone={item.decision ? 'green' : riskTone(item.risk)} />
        <span className={s.foldedTitle}>{item.title}</span>
        <span className={s.foldedMeta}>{item.decision ? 'Decided' : clock ?? ''}</span>
        <span className={s.chev} data-open={open || undefined}><Icon name="down" /></span>
      </button>
      {open && (
        <div id={id} className={s.foldedBody}>
          <p className={s.meta}>{kicker(item, world)}{item.owner ? ` · ${deskName(world, item.owner)}` : ''}</p>
          {item.detail && <p className={s.detail}>{item.detail}</p>}
          {item.proposal && item.proposal.status !== 'FAILED' && <OutcomeList steps={payloadSteps(item.proposal, world)} />}
          {!item.decision && <p>{item.next.text} <SourceTag source={item.next.source} /></p>}
          <DecisionControls item={item} compact />
        </div>
      )}
    </li>
  );
}

function FactRow({ fact, now }: { fact: Fact; now: string }) {
  return (
    <div className={s.fact}>
      <dt className={s.factLabel}>{fact.label}</dt>
      <dd className={s.factValue}>{fact.value}</dd>
      <dd className={s.factSource}>
        <CertaintyWord c={fact.certainty} />
        {fact.by && <span> · {fact.by}</span>}
        {fact.at && <span> · <When iso={fact.at} now={now} /></span>}
        {fact.note && <span> · {fact.note}</span>}
      </dd>
    </div>
  );
}

const TIMELINE_PAGE = 25;

function Timeline({ entries, now }: { entries: TimelineEntry[]; now: string }) {
  const [who, setWho] = useState<Who | ''>('');
  const [all, setAll] = useState(false);
  const present = useMemo(() => [...new Set(entries.map((e) => e.who))], [entries]);
  const list = entries.filter((e) => !who || e.who === who);
  const shown = all ? list : list.slice(0, TIMELINE_PAGE);
  return (
    <section className={s.section} aria-labelledby="timeline">
      <div className={s.timelineHead}>
        <h2 id="timeline" className={s.sectionTitle}>What happened <span className={s.count}>{list.length}</span></h2>
        <label>
          <span className="visually-hidden">Show</span>
          <select value={who} onChange={(e) => setWho(e.target.value as Who | '')} className={s.select}>
            <option value="">Everyone</option>
            {present.map((w) => <option key={w} value={w}>{WHO_LABEL[w]}</option>)}
          </select>
        </label>
      </div>
      {list.length === 0 ? (
        <p className={s.meta}>Nothing recorded from {who ? WHO_LABEL[who as Who].toLowerCase() : 'anyone'} on this order.</p>
      ) : (
        <ol className={s.timeline}>
          {shown.map((e) => (
            <li key={e.id} className={s.entry}>
              <span className={s.entryTime}><When iso={e.at} now={now} /></span>
              <div className={s.entryBody}>
                <p className={s.entryWho}>
                  <span className={s.entryActor}>{e.actor}</span>
                  <span className={s.meta}> · {WHO_LABEL[e.who]}{e.internal ? ', internal' : ''}</span>
                </p>
                <p className={e.kind === 'message' ? s.entryMessage : s.entryText}>{e.text}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {list.length > TIMELINE_PAGE && (
        <button type="button" className={s.textButton} onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

function AllRecords({ rows }: { rows: { collection: string; id: string; data: unknown }[] }) {
  const grouped = useMemo(() => {
    const m = new Map<string, { id: string; data: unknown }[]>();
    for (const r of rows) {
      const l = m.get(r.collection) ?? [];
      l.push(r);
      m.set(r.collection, l);
    }
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [rows]);
  return (
    <details className={s.records}>
      <summary className={s.recordsSummary}>All records <span className={s.count}>{rows.length}</span></summary>
      <p className={s.meta}>The raw rows behind this page, unchanged from the snapshot.</p>
      {grouped.map(([collection, list]) => (
        <details key={collection} className={s.recordGroup}>
          <summary>{humanize(collection)} <span className={s.count}>{list.length}</span></summary>
          <pre className={s.pre}>{list.map((r) => JSON.stringify(r.data, null, 2)).join('\n\n')}</pre>
        </details>
      ))}
    </details>
  );
}

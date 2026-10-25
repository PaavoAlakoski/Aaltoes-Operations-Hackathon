// When the driver won't make the pickup, tell the dealer. The dealer has no app
// yet, so what is written here stays in this window: nothing is sent anywhere.
import { useState, type FormEvent } from 'react';
import { localTime, minutesPhrase, type Vehicle } from '@bahn/shared';
import { usePickup } from './InTime';
import { useOps } from './ops';
import s from './live.module.css';

type Sent = { id: number; at: string; by: string; body: string };

export function DealerChat({ vehicle }: { vehicle: Vehicle }) {
  const p = usePickup(vehicle);
  if (!p || p.state !== 'late') return null;
  // Keyed by car so another order page starts a fresh draft.
  return <Panel key={vehicle.id} vehicle={vehicle} pickup={p} />;
}

function Panel({ vehicle, pickup }: { vehicle: Vehicle; pickup: NonNullable<ReturnType<typeof usePickup>> }) {
  const { profile } = useOps();
  const { site, driver, eta, closes, margin } = pickup;
  const tz = site.timezone;
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<Sent[]>([]);
  const [body, setBody] = useState(() =>
    [
      `Hello ${site.name},`,
      `our driver ${driver?.full_name ?? ''} for order ${vehicle.order_ref ?? vehicle.id} is running late`
        + `${eta ? ` and now expects to arrive at ${localTime(eta, tz)}` : ''}`
        + `${closes ? `, ${margin != null ? `${minutesPhrase(margin)} after` : 'after'} your key handover closes at ${localTime(closes, tz)}` : ''}.`,
      'Could you hold the keys for us, or tell us how the handover can still happen today?',
      'Thank you.',
    ].join('\n'),
  );

  function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setSent((l) => [...l, { id: Date.now(), at: new Date().toISOString(), by: profile?.full_name ?? 'You', body: body.trim() }]);
    setBody('');
  }

  if (!open) {
    return (
      <div className={s.inline} style={{ marginBottom: 'var(--s4)' }}>
        <button type="button" className={s.primary} onClick={() => setOpen(true)}>Notify the dealership</button>
      </div>
    );
  }

  return (
    <section className={s.dealer} aria-label="Notify the dealership">
      <div className={s.dealerHead}>
        <h3 className={s.h3}>{site.name} · {site.city}</h3>
        <button type="button" className={s.textButton} onClick={() => setOpen(false)}>Close</button>
      </div>
      {site.access_note && <p className={s.meta}>{site.access_note}</p>}
      {sent.length > 0 && (
        <ol className={s.messages}>
          {sent.map((m) => (
            <li key={m.id} data-mine>
              <span className={s.meta}>{m.by} · {localTime(m.at, tz)}</span>
              <p style={{ whiteSpace: 'pre-line' }}>{m.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form className={s.compose} onSubmit={send}>
        <label className="visually-hidden" htmlFor={`dealer-${vehicle.id}`}>Message to the dealership</label>
        <textarea id={`dealer-${vehicle.id}`} className={s.input} rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write to the dealership…" />
        <div className={s.inline}>
          <span className={s.meta}>Not delivered anywhere yet. Kept in this window only.</span>
          <button type="submit" className={s.primary} disabled={!body.trim()}>Send</button>
        </div>
      </form>
    </section>
  );
}

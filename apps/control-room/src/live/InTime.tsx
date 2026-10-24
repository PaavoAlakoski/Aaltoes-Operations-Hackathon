// Is the driver going to make the pickup? pickup-watch stores the answer on
// the car (ETA from the driver's trip and Google drive time, against the
// dealer's key handover); this shows it big enough to read across the room.
import { localTime, minutesPhrase, type Vehicle } from '@bahn/shared';
import { useOps } from './ops';
import s from './live.module.css';

const HANDOVER: Record<string, string> = { staff_only: 'in person', key_box: 'by key box', unknown: 'handover not recorded' };

function minutesAgo(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : `${minutesPhrase(m)} ago`;
}

/** What the banner and the pill both need, or null when the car is not waiting for a tracked pickup. */
function usePickup(vehicle: Vehicle | undefined) {
  const { sites, staff } = useOps();
  if (!vehicle || vehicle.status !== 'waiting_pickup' || !vehicle.pickup_site_id) return null;
  const site = sites.get(vehicle.pickup_site_id);
  if (!site) return null;
  const driver = staff.find((p) => p.vehicle_id === vehicle.id && p.role === 'driver');
  const closes = site.closes_at;
  const eta = vehicle.pickup_eta;
  const margin = eta && closes ? Math.round((Date.parse(closes) - Date.parse(eta)) / 60000) : null;
  const state: 'in' | 'late' | 'unknown' = vehicle.pickup_in_time === true ? 'in' : vehicle.pickup_in_time === false ? 'late' : 'unknown';
  return { site, driver, closes, eta, margin, state };
}

export function InTimeBanner({ vehicle }: { vehicle: Vehicle }) {
  const p = usePickup(vehicle);
  if (!p) return null;
  const { site, driver, closes, eta, margin, state } = p;
  const tz = site.timezone;
  const word = state === 'in' ? 'In time' : state === 'late' ? 'Won’t make it' : 'Checking…';
  const by = margin == null ? null : state === 'late' ? `${minutesPhrase(margin)} late` : `${minutesPhrase(margin)} to spare`;

  return (
    <section className={s.inTime} data-state={state} aria-live="polite" aria-label="Is the driver in time for the pickup">
      <p className={s.inTimeWord}>{word}</p>
      <div className={s.inTimeFacts}>
        <p className={s.inTimeLine}>
          {driver?.full_name ?? 'No driver'} → {site.name}
        </p>
        <p className={s.inTimeNumbers}>
          <span>ETA <strong className="mono">{eta ? localTime(eta, tz) : '–'}</strong></span>
          <span>Keys {HANDOVER[site.key_handover] ?? site.key_handover} until <strong className="mono">{closes ? localTime(closes, tz) : '–'}</strong></span>
          {by && <span><strong>{by}</strong></span>}
        </p>
        {(vehicle.pickup_eta_basis || vehicle.pickup_checked_at) && (
          <p className={s.inTimeBasis}>
            {vehicle.pickup_eta_basis}
            {vehicle.pickup_checked_at && <> · checked {minutesAgo(vehicle.pickup_checked_at)}</>}
            {' · '}local time ({tz.split('/')[1]?.replace('_', ' ') ?? tz})
          </p>
        )}
      </div>
    </section>
  );
}

/** The same answer in a word, for lists. */
export function InTimePill({ vehicle }: { vehicle: Vehicle | undefined }) {
  const p = usePickup(vehicle);
  if (!p || p.state === 'unknown') return null;
  return (
    <span className={s.inTimePill} data-state={p.state}>
      {p.state === 'in' ? 'In time' : `Won’t make it${p.margin != null ? ` · ${minutesPhrase(p.margin)} late` : ''}`}
    </span>
  );
}

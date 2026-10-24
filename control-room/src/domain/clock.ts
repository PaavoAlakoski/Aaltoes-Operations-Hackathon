// The dataset is a frozen snapshot. "Now" is always manifest.snapshot_at,
// never the real clock, so every "in 2 h" and "3 h ago" is measured from it.

/** Operations work in Helsinki time unless a record carries its own zone. */
export const OPS_TIME_ZONE = 'Europe/Helsinki';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / MIN);
}

/** "in 25 min", "in 3 h", "in 2 days", "40 min ago", "yesterday"… relative to the snapshot. */
export function relative(iso: string, now: string): string {
  const diff = Date.parse(iso) - Date.parse(now);
  const abs = Math.abs(diff);
  const future = diff >= 0;
  let span: string;
  if (abs < MIN) return 'now';
  if (abs < HOUR) span = `${Math.round(abs / MIN)} min`;
  else if (abs < DAY) {
    const h = abs / HOUR;
    span = h < 10 ? `${Math.round(h * 2) / 2} h`.replace('.5', '½') : `${Math.round(h)} h`;
  } else {
    const d = Math.round(abs / DAY);
    if (d === 1) return future ? 'tomorrow' : 'yesterday';
    span = `${d} days`;
  }
  return future ? `in ${span}` : `${span} ago`;
}

export function isPast(iso: string, now: string): boolean {
  return Date.parse(iso) < Date.parse(now);
}

/** "Wed 21 Oct, 11:00" in the given zone. */
export function formatTime(iso: string, timeZone: string = OPS_TIME_ZONE): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d);
  return `${day.replace(',', '')}, ${time}`;
}

/** "11:00" if the same day as the snapshot in that zone, else the full date and time. */
export function formatShort(iso: string, now: string, timeZone: string = OPS_TIME_ZONE): string {
  const dayKey = (x: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(x));
  if (dayKey(iso) === dayKey(now)) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(new Date(iso));
  }
  return formatTime(iso, timeZone);
}

/** A short city name for a zone, for labels like "(Berlin time)". */
export function zoneCity(timeZone: string): string {
  return (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}

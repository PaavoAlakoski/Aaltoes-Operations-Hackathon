// Sending a car's position, the same way from the driver app and the
// simulator: every fix goes out live on the corridor's Broadcast channel, and
// one every PERSIST_EVERY_MS is stored through report_position.
import { PERSIST_EVERY_MS, POSITION_EVENT, corridorTopic, type OpsClient, type PositionPayload } from './index';

export type LngLat = [number, number];

const toRad = (d: number) => (d * Math.PI) / 180;
export function km(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export function pathKm(path: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += km(path[i - 1]!, path[i]!);
  return total;
}

/** The point a fraction (0..1) of the way along a path. */
export function pointAlong(path: LngLat[], fraction: number): { lat: number; lng: number } {
  const f = Math.min(Math.max(fraction, 0), 1);
  let left = f * pathKm(path);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = km(a, b);
    if (left <= seg || i === path.length - 1) {
      const t = seg === 0 ? 0 : Math.min(left / seg, 1);
      return { lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t };
    }
    left -= seg;
  }
  return { lng: path[0]![0], lat: path[0]![1] };
}

/** Roughly how far along a path a point is, by its nearest vertex-sampled position. */
export function fractionNear(path: LngLat[], lat: number, lng: number, samples = 400): number {
  let best = 0;
  let bestKm = Infinity;
  for (let i = 0; i <= samples; i++) {
    const p = pointAlong(path, i / samples);
    const d = km([p.lng, p.lat], [lng, lat]);
    if (d < bestKm) {
      bestKm = d;
      best = i / samples;
    }
  }
  return best;
}

export class PositionPublisher {
  private lastStored = 0;
  private channel: ReturnType<OpsClient['channel']>;

  constructor(private db: OpsClient, corridorId: string, private vehicleId: string) {
    this.channel = db.channel(corridorTopic(corridorId), { config: { private: true } });
  }

  /** Sends one fix. Returns whether it was also stored. */
  async publish(lat: number, lng: number, delaySeconds: number): Promise<{ live: boolean; stored: boolean; error?: string }> {
    const payload: PositionPayload = { vehicle_id: this.vehicleId, lat, lng, delay_seconds: delaySeconds, at: new Date().toISOString() };
    // httpSend rejects on a refused send (e.g. 403 for a corridor that is not
    // this driver's) instead of returning success: false, so catch both.
    const sent = await this.channel
      .httpSend(POSITION_EVENT, payload)
      .catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }));
    let stored = false;
    let error = sent.success ? undefined : `broadcast: ${sent.error}`;
    if (Date.now() - this.lastStored >= PERSIST_EVERY_MS) {
      const { data, error: rpcError } = await this.db.rpc('report_position', { p_lat: lat, p_lng: lng, p_delay_seconds: Math.round(delaySeconds) });
      if (rpcError) error = `report_position: ${rpcError.message}`;
      else {
        this.lastStored = Date.now();
        stored = Boolean((data as { saved?: boolean } | null)?.saved);
      }
    }
    return { live: sent.success, stored, error };
  }

  async close() {
    await this.db.removeChannel(this.channel);
  }
}

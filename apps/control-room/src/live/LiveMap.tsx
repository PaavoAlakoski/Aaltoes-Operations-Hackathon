// Corridors as lines, cars as dots. Positions arrive over Broadcast every few
// seconds, so markers are moved in place rather than redrawn. On an order page
// the car's own route replaces its corridor: the itinerary's drive legs, which
// follow the road Google Routes returned (a straight estimate for cars that do
// not use Google), and the ferry crossing dashed.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { delayPhrase, type Corridor, type Leg, type Vehicle } from '@bahn/shared';
import s from './live.module.css';

type Tone = 'green' | 'orange' | 'red' | 'grey';

export function vehicleTone(v: Vehicle, hasOpenIncident: boolean): Tone {
  if (v.status === 'waiting_pickup' || v.status === 'delivered') return 'grey';
  if (hasOpenIncident || v.status === 'needs_check' || v.delay_seconds > 1800) return 'red';
  if (v.delay_seconds > 300) return 'orange';
  return 'green';
}

// Read from the brand tokens so the map matches the rest of the app.
function colour(tone: Tone): string {
  const css = getComputedStyle(document.documentElement);
  const v = { green: '--green', orange: '--orange', red: '--red', grey: '--warm-grey' }[tone];
  return css.getPropertyValue(v).trim() || '#726958';
}

export function LiveMap({ corridors, vehicles, flagged, selectedVehicle, onSelect, focus, site, route, className }: {
  corridors: Corridor[];
  vehicles: Vehicle[];
  /** Cars with an incident that is not resolved. */
  flagged: Set<string>;
  selectedVehicle: string | null;
  onSelect: (vehicleId: string) => void;
  /** Start here, and follow it when it moves off screen, instead of the whole network. */
  focus?: { lat: number; lng: number; zoom?: number } | null;
  /** The pickup dealer, as a ring. */
  site?: { lat: number; lng: number; name: string } | null;
  /** The car's itinerary legs; drawn instead of the corridors when given. */
  route?: Leg[] | null;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.CircleMarker>());
  const select = useRef(onSelect);
  select.current = onSelect;
  const start = useRef(focus);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(
      start.current ? [start.current.lat, start.current.lng] : [57.5, 15.5],
      start.current ? (start.current.zoom ?? 9) : 5,
    );
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 12,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      markers.current.clear();
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || route) return;
    const lines = corridors.map((c) => {
      const path = (c.path as [number, number][]).map(([lng, lat]) => [lat, lng] as [number, number]);
      return L.polyline(path, { color: c.color, weight: 3, opacity: 0.55 }).bindTooltip(c.name, { sticky: true }).addTo(m);
    });
    return () => lines.forEach((l) => l.remove());
  }, [corridors, route]);

  // The route, and the whole of it in view the first time it arrives.
  const fitted = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m || !route) return;
    const ink = colour('grey');
    const layers: L.Layer[] = [];
    const bounds = L.latLngBounds([]);
    for (const leg of route) {
      if (!leg.path || leg.path.length < 2 || (leg.kind !== 'drive' && leg.kind !== 'ferry')) continue;
      const path = leg.path.map(([lng, lat]) => [lat, lng] as [number, number]);
      path.forEach((p) => bounds.extend(p));
      const done = leg.status === 'done';
      const via = leg.source === 'google' ? 'Google Maps route' : leg.kind === 'ferry' ? 'ferry crossing' : 'straight-line estimate';
      layers.push(
        L.polyline(path, {
          color: ink, weight: leg.kind === 'ferry' ? 3 : 4, opacity: done ? 0.35 : 0.85,
          dashArray: leg.kind === 'ferry' ? '6 8' : undefined,
        }).bindTooltip(`${leg.title}${leg.km ? ` · ${Math.round(leg.km)} km` : ''} · ${via}`, { sticky: true }).addTo(m),
      );
    }
    if (!fitted.current && bounds.isValid()) {
      fitted.current = true;
      m.fitBounds(bounds, { padding: [24, 24] });
    }
    return () => layers.forEach((l) => l.remove());
  }, [route]);

  // Follow the car, but only once it leaves the middle of the view.
  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    if (!m.getBounds().pad(-0.2).contains([focus.lat, focus.lng])) m.panTo([focus.lat, focus.lng]);
  }, [focus?.lat, focus?.lng]);

  useEffect(() => {
    const m = map.current;
    if (!m || !site) return;
    const ring = L.circleMarker([site.lat, site.lng], {
      radius: 8, color: colour('grey'), weight: 3, fillColor: '#fffef7', fillOpacity: 1,
    }).bindTooltip(site.name).addTo(m);
    return () => { ring.remove(); };
  }, [site?.lat, site?.lng, site?.name]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const v of vehicles) {
      if (v.lat == null || v.lng == null) continue;
      seen.add(v.id);
      const tone = vehicleTone(v, flagged.has(v.id));
      const selected = v.id === selectedVehicle;
      const style = {
        radius: selected ? 9 : 6, color: selected ? '#12110e' : '#fffef7', weight: selected ? 3 : 1.5,
        fillColor: colour(tone), fillOpacity: 1,
      };
      const label = `${v.label} · ${v.order_ref ?? v.id} · ${v.status === 'waiting_pickup' ? 'Waiting for pickup' : delayPhrase(v.delay_seconds)}`;
      const existing = markers.current.get(v.id);
      if (existing) {
        existing.setLatLng([v.lat, v.lng]).setStyle(style).setTooltipContent(label);
      } else {
        const mk = L.circleMarker([v.lat, v.lng], style).bindTooltip(label).addTo(m);
        mk.on('click', () => select.current(v.id));
        markers.current.set(v.id, mk);
      }
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.remove();
        markers.current.delete(id);
      }
    }
  }, [vehicles, flagged, selectedVehicle]);

  return <div ref={el} className={className ?? s.map} role="region" aria-label="Map of cars on their corridors" />;
}

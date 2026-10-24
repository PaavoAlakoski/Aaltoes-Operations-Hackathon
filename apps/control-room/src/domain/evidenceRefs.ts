// Turns a proposal's evidence references into short, attributed lines, each
// with its certainty. A reference we cannot find says so instead of guessing.
import type { Ref } from './types';
import type { World } from './world';
import { bookingFact, messageClaim, positionFact, quoteFact, type Fact } from './evidence';
import { alertStatusLabel, eventLabel, incidentLabel, proofKindLabel, proofStatusLabel, signalLabel, actorLabel } from './labels';

export function evidenceLine(ref: Ref, orderId: string, world: World): Fact {
  const b = world.bundles.get(orderId);
  switch (ref.table) {
    case 'messages': {
      const m = b?.messages.find((x) => x.id === ref.id);
      if (m) {
        const f = messageClaim(m, 'Message');
        const name = m.author_name_snapshot
          ?? (m.author_type === 'driver' ? world.drivers.get(m.author_id ?? '')?.display_name
            : m.author_type === 'customer' ? world.customers.get(m.author_id ?? '')?.name
              : m.author_type === 'operator' ? world.operators.get(m.author_id ?? '')?.title : undefined);
        return { ...f, by: name ? `${name} (${actorLabel(m.author_type).toLowerCase()})` : actorLabel(m.author_type) };
      }
      break;
    }
    case 'alerts': {
      const a = b?.alerts.find((x) => x.id === ref.id);
      if (a) return { label: 'Signal', value: `${signalLabel(a.signal)} (${alertStatusLabel(a.status).toLowerCase()})`, certainty: 'stated', by: 'monitoring', at: a.triggered_at, note: 'A reason to look, not a diagnosis' };
      break;
    }
    case 'travel_options': {
      const o = b?.options.find((x) => x.id === ref.id);
      if (o) return quoteFact(o);
      break;
    }
    case 'travel_reservations': {
      const r = b?.reservations.find((x) => x.id === ref.id);
      if (r) return bookingFact(r);
      break;
    }
    case 'operational_events': {
      const e = world.eventsById.get(ref.id);
      if (e) return { label: 'Recorded', value: eventLabel(e.command), certainty: 'confirmed', by: actorLabel(e.actor_type).toLowerCase(), at: e.recorded_at };
      break;
    }
    case 'proofs': {
      const p = b?.proofs.find((x) => x.id === ref.id);
      if (p) return { label: proofKindLabel(p.kind), value: proofStatusLabel(p.status), certainty: p.status === 'APPROVED' ? 'confirmed' : 'stated', by: 'proof record', at: p.submitted_at ?? null };
      break;
    }
    case 'incidents': {
      const i = b?.incidents.find((x) => x.id === ref.id);
      if (i) return { label: 'Incident', value: incidentLabel(i.kind), certainty: 'stated', by: 'operations', at: i.opened_at };
      break;
    }
    case 'work_assignments': {
      const a = b?.assignments.find((x) => x.id === ref.id);
      if (a) return { label: 'Driver booking', value: world.drivers.get(a.driver_id)?.display_name ?? 'Driver', certainty: 'confirmed', by: 'booking record', at: a.accepted_at };
      break;
    }
    case 'tracking_observations': {
      const t = b?.tracking.find((x) => x.id === ref.id);
      const f = positionFact(t, false);
      if (f) return f;
      break;
    }
    case 'ferry_terminal_events':
      return { label: 'Gate', value: 'Terminal gate observation', certainty: 'confirmed', by: 'terminal gate reader', at: null };
  }
  return { label: 'Record', value: 'Referenced record is not in this snapshot', certainty: 'missing', by: null, at: null };
}

// The whole snapshot, loaded once and indexed by order. Every derivation in
// the app reads from a World; nothing reads the database directly.
import type {
  Address, Agent, Alert, Assignment, Attachment, Conversation, Customer, CustodyAsset, Document, Driver,
  EndpointClaim, EndpointDetail, InboxMessage, InboxThread, Incident, Message, Notification, OpEvent, Operator,
  Order, OrderItem, Plan, Point, Proof, Proposal, RecordRow, Reservation, Segment, Site, Step, TimeWindow,
  Tracking, TravelOption, Vehicle, WorkItem, Offer,
} from './types';

export interface OrderBundle {
  order: Order;
  items: OrderItem[];
  vehicles: Vehicle[];
  plans: Plan[];
  activePlan: Plan | null;
  points: Point[];
  segments: Segment[];
  windows: TimeWindow[];
  offers: Offer[];
  assignments: Assignment[];
  steps: Step[];
  reservations: Reservation[];
  options: TravelOption[];
  tracking: Tracking[];
  alerts: Alert[];
  incidents: Incident[];
  workItems: WorkItem[];
  /** Conversations filed on this order, plus those filed elsewhere that name it. */
  conversations: Conversation[];
  messages: Message[];
  proposals: Proposal[];
  endpoints: EndpointDetail[];
  claims: EndpointClaim[];
  custody: CustodyAsset[];
  documents: Document[];
  proofs: Proof[];
  events: OpEvent[];
  notifications: Notification[];
  attachments: Attachment[];
  /** Every row that names this order, for the "All records" disclosure. */
  raw: RecordRow[];
}

export interface World {
  snapshotAt: string;
  orders: Order[];
  bundles: Map<string, OrderBundle>;
  byReference: Map<string, OrderBundle>;
  customers: Map<string, Customer>;
  drivers: Map<string, Driver>;
  operators: Map<string, Operator>;
  agents: Map<string, Agent>;
  addresses: Map<string, Address>;
  sites: Map<string, Site>;
  eventsById: Map<string, OpEvent>;
  inboxThreads: InboxThread[];
  inboxMessages: Map<string, InboxMessage[]>;
  proposals: Proposal[];
}

function byTime<T>(key: (t: T) => string | null | undefined) {
  return (a: T, b: T) => (key(a) ?? '').localeCompare(key(b) ?? '');
}

export function buildWorld(rows: RecordRow[]): World {
  const col = new Map<string, unknown[]>();
  const rawByOrder = new Map<string, RecordRow[]>();
  for (const r of rows) {
    let list = col.get(r.collection);
    if (!list) col.set(r.collection, (list = []));
    list.push(r.data);
    if (r.order_id && r.collection !== 'manifest') {
      let raw = rawByOrder.get(r.order_id);
      if (!raw) rawByOrder.set(r.order_id, (raw = []));
      raw.push(r);
    }
  }
  const all = <T>(name: string) => (col.get(name) ?? []) as T[];
  const mapOf = <T extends { id: string }>(name: string) => new Map(all<T>(name).map((x) => [x.id, x]));
  const groupBy = <T>(list: T[], key: (t: T) => string | null | undefined) => {
    const m = new Map<string, T[]>();
    for (const x of list) {
      const k = key(x);
      if (!k) continue;
      let l = m.get(k);
      if (!l) m.set(k, (l = []));
      l.push(x);
    }
    return m;
  };

  const manifest = all<{ snapshot_at: string }>('manifest')[0];
  if (!manifest) throw new Error('The snapshot manifest is missing. Run the seed again.');

  const orders = all<Order>('orders').slice().sort((a, b) => a.reference.localeCompare(b.reference));
  const vehicles = mapOf<Vehicle>('vehicles');
  const plans = all<Plan>('transport_plans');
  const planOrder = new Map(plans.map((p) => [p.id, p.order_id]));
  const points = groupBy(all<Point>('transport_points'), (p) => planOrder.get(p.plan_id));
  const segments = groupBy(all<Segment>('transport_segments'), (s) => planOrder.get(s.plan_id));
  const per = <T extends { order_id?: string | null }>(name: string) => groupBy(all<T>(name), (x) => x.order_id);

  const items = per<OrderItem>('order_items');
  const plansBy = per<Plan>('transport_plans');
  const windows = per<TimeWindow>('time_windows');
  const assignments = per<Assignment>('work_assignments');
  const steps = per<Step>('assignment_steps');
  const reservations = per<Reservation>('travel_reservations');
  const options = per<TravelOption>('travel_options');
  const tracking = per<Tracking>('tracking_observations');
  const alerts = per<Alert>('alerts');
  const incidents = per<Incident>('incidents');
  const workItems = per<WorkItem>('work_items');
  const messages = groupBy(all<Message>('messages'), (m) => m.conversation_id);
  const proposals = per<Proposal>('agent_proposals');
  const endpoints = per<EndpointDetail>('order_endpoint_details');
  const claims = per<EndpointClaim>('endpoint_claims');
  const custody = per<CustodyAsset>('custody_assets');
  const documents = per<Document>('documents');
  const proofs = per<Proof>('proofs');
  const events = per<OpEvent>('operational_events');
  const notifications = per<Notification>('internal_notifications');
  const attachments = per<Attachment>('attachments');

  // Offers: a bundle names its member orders in order_ids.
  const offers = new Map<string, Offer[]>();
  for (const o of all<Offer>('market_offers')) {
    for (const id of new Set([o.order_id, ...(o.order_ids ?? [])])) {
      let l = offers.get(id);
      if (!l) offers.set(id, (l = []));
      l.push(o);
    }
  }

  // Conversations count for their filing order and every related order.
  const conversations = new Map<string, Conversation[]>();
  for (const c of all<Conversation>('conversations')) {
    for (const id of new Set([c.order_id, ...(c.related_order_ids ?? [])])) {
      let l = conversations.get(id);
      if (!l) conversations.set(id, (l = []));
      l.push(c);
    }
  }

  const bundles = new Map<string, OrderBundle>();
  const byReference = new Map<string, OrderBundle>();
  for (const order of orders) {
    const its = items.get(order.id) ?? [];
    const ps = (plansBy.get(order.id) ?? []).slice().sort((a, b) => a.version - b.version);
    const activePlan = ps.find((p) => p.id === order.active_plan_id) ?? null;
    const convs = (conversations.get(order.id) ?? []).slice().sort(byTime((c) => c.updated_at));
    const b: OrderBundle = {
      order,
      items: its,
      vehicles: its.map((i) => vehicles.get(i.vehicle_id)).filter((v): v is Vehicle => !!v),
      plans: ps,
      activePlan,
      points: (points.get(order.id) ?? []).slice().sort((a, b) => a.sequence - b.sequence),
      segments: segments.get(order.id) ?? [],
      windows: windows.get(order.id) ?? [],
      offers: offers.get(order.id) ?? [],
      assignments: assignments.get(order.id) ?? [],
      steps: (steps.get(order.id) ?? []).slice().sort(byTime((s) => s.scheduled_start_at)),
      reservations: (reservations.get(order.id) ?? []).slice().sort(byTime((r) => r.departure_at)),
      options: (options.get(order.id) ?? []).slice().sort(byTime((o) => o.departure_at)),
      tracking: (tracking.get(order.id) ?? []).slice().sort(byTime((t) => t.observed_at)),
      alerts: alerts.get(order.id) ?? [],
      incidents: incidents.get(order.id) ?? [],
      workItems: workItems.get(order.id) ?? [],
      conversations: convs,
      messages: convs.flatMap((c) => messages.get(c.id) ?? []).sort(byTime((m) => m.authored_at)),
      proposals: (proposals.get(order.id) ?? []).slice().sort(byTime((p) => p.created_at)),
      endpoints: endpoints.get(order.id) ?? [],
      claims: claims.get(order.id) ?? [],
      custody: custody.get(order.id) ?? [],
      documents: documents.get(order.id) ?? [],
      proofs: proofs.get(order.id) ?? [],
      events: (events.get(order.id) ?? []).slice().sort(byTime((e) => e.recorded_at)),
      notifications: notifications.get(order.id) ?? [],
      attachments: attachments.get(order.id) ?? [],
      raw: rawByOrder.get(order.id) ?? [],
    };
    bundles.set(order.id, b);
    byReference.set(order.reference, b);
  }

  const inboxMessages = groupBy(all<InboxMessage>('support_inbox_messages'), (m) => m.thread_id);
  for (const l of inboxMessages.values()) l.sort(byTime((m) => m.authored_at));

  return {
    snapshotAt: manifest.snapshot_at,
    orders,
    bundles,
    byReference,
    customers: mapOf<Customer>('customers'),
    drivers: mapOf<Driver>('drivers'),
    operators: mapOf<Operator>('operators'),
    agents: mapOf<Agent>('agents'),
    addresses: mapOf<Address>('addresses'),
    sites: mapOf<Site>('sites'),
    eventsById: mapOf<OpEvent>('operational_events'),
    inboxThreads: all<InboxThread>('support_inbox_threads').slice().sort(byTime((t) => t.opened_at)),
    inboxMessages,
    proposals: all<Proposal>('agent_proposals'),
  };
}

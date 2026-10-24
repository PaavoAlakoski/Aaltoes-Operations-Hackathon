// Every code in the records, said in plain operations language. The UI never
// shows a raw code: anything not listed here goes through `humanize`.

export function humanize(code: string | null | undefined): string {
  if (!code) return '';
  const words = code.replace(/[._]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lookup(table: Record<string, string>, code: string | null | undefined): string {
  if (!code) return '';
  return table[code] ?? humanize(code);
}

export const STAGE_LABEL = {
  preparing: 'Preparing',
  ready: 'Ready to offer',
  market: 'On the driver market',
  booked: 'Driver booked',
  moving: 'Moving',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
} as const;

const SIGNAL: Record<string, string> = {
  TRACKING_GAP: 'No recent position from the driver app',
  RELEASE_DOCUMENT_UNCLEAR: 'Release paper unclear',
  SITE_ACCESS_UNCONFIRMED: 'Pickup access not confirmed',
  DRIVER_AVAILABILITY_RISK: 'Driver may not be able to go',
  FERRY_CONNECTION_RISK: 'Ferry connection at risk',
  DELIVERY_ACCESS_RISK: 'Delivery access at risk',
  PROOF_REVIEW: 'Signed delivery proof requested',
  CONDITION_CLAIM_REVIEW: 'Condition claim to review',
  INVOICE_REFERENCE_QUERY: 'Invoice question',
  EMPTY_PICKUP: 'Driver found no car at pickup',
  FERRY_SOLD_OUT: 'Ferry sold out',
  SAFETY_STOP: 'Driver stopped: warning light',
  CONDITION_CLAIM: 'Customer reports a mark after delivery',
  SITE_ACCESS_CONFLICT: 'Site records disagree on where the car is',
  FR_IMPORT_TRAVEL_DECISION: 'Crossing sold out, travel plan needed',
  FERRY_TRACKING_GAP_CONTEXT: 'No position during the ferry crossing',
  POSITIONING_AT_RISK: 'Driver can’t reach the next pickup in time',
  PICKUP_PROOF_REJECTED: 'Pickup photos rejected',
  DELIVERY_PROMISE_UNACHIEVABLE: 'Delivery promise can’t be met',
};
export const signalLabel = (c: string) => lookup(SIGNAL, c);

const INCIDENT: Record<string, string> = {
  EMPTY_PICKUP: 'Empty pickup',
  TRAVEL_CAPACITY: 'No space on the crossing',
  VEHICLE_WARNING: 'Vehicle warning on the road',
  POST_DELIVERY_CONDITION_CLAIM: 'Condition claim after delivery',
};
export const incidentLabel = (c: string) => lookup(INCIDENT, c);

const INCIDENT_STATUS: Record<string, string> = {
  INVESTIGATING: 'being investigated',
  AWAITING_DECISION: 'waiting for a decision',
  NEEDS_HUMAN: 'needs a person',
};
export const incidentStatusLabel = (c: string) => lookup(INCIDENT_STATUS, c).toLowerCase();

const WORK_KIND: Record<string, string> = {
  MARKET_VISIBILITY_CHECK: 'Decide whether the live offer stays up',
  SITE_HANDOVER_REVIEW: 'Check releases at a shared site',
  DRIVER_START_CHECK: 'Check where the driver starts from',
  BACKUP_DRIVER_DECISION: 'Decide on a backup driver',
  SIGNED_HANDOVER_FOLLOWUP: 'Get the signed handover',
  IDENTITY_INPUT_REQUIRED: 'Car identity missing',
  PICKUP_CONTACT_HANDLE_REQUIRED: 'Pickup contact missing',
  PICKUP_ACCESS_CHECK_REQUIRED: 'Pickup address and access missing',
  VEHICLE_RECOVERY_DECISION: 'Decide how the car is recovered',
  PICKUP_EVIDENCE_FOLLOWUP: 'Replace the rejected pickup photos',
  RECEIVER_AUTHORITY_CHECK: 'Nobody authorised to receive the car',
  KEY_HOLDER_STOCK_CHECK: 'Find who holds the keys',
  COMMERCIAL_RELEASE_HOLD: 'Seller hold on the car',
};
export const workKindLabel = (c: string) => lookup(WORK_KIND, c);

const WAITING_ON: Record<string, string> = {
  OPERATOR_FOLLOWUP: 'one of us',
  SITE_CONFIRMATION: 'the site to confirm',
  CUSTOMER_VEHICLE_IDENTITY: 'the customer to send the car’s identity',
  CORRECTED_EXPENSE_REVIEW: 'a review of the corrected expense',
  STOCK_CONTROL_REPLY: 'stock control to reply',
  SELLER_HOLD_CLEARANCE: 'the seller to lift the hold',
  DRIVER_DUTY_REFERENCE: 'the driver to send the job reference',
  DOCUMENT_READY: 'the document to be ready',
  SENDER_CORRECTION: 'the sender to correct the reference',
  PAYOUT_RECONCILIATION: 'payout reconciliation',
};
export const waitingOnLabel = (c: string) => lookup(WAITING_ON, c).toLowerCase();

/** Waiting on someone outside our team, as opposed to one of us. */
export const EXTERNAL_WAITS = new Set([
  'SITE_CONFIRMATION', 'CUSTOMER_VEHICLE_IDENTITY', 'STOCK_CONTROL_REPLY', 'SELLER_HOLD_CLEARANCE',
  'DRIVER_DUTY_REFERENCE', 'DOCUMENT_READY', 'SENDER_CORRECTION',
]);

const CATEGORY: Record<string, string> = {
  pickup_and_release: 'pickup and release',
  driver_availability: 'driver availability',
  ferry_and_route: 'ferry and route',
  delivery_and_receiver: 'delivery and receiver',
  documents_and_proof: 'documents and proof',
  vehicle_condition: 'vehicle condition',
  costs_and_payments: 'costs and payments',
  schedule_and_eta: 'schedule and arrival time',
  order_information: 'order details',
  driver_travel: 'driver travel',
  order_change: 'order change',
  vehicle_custody: 'keys and custody',
  offer_and_pricing: 'offer and price',
  travel_and_assignment: 'travel and assignment',
  document_request: 'document request',
  general_policy: 'general question',
  order_status: 'order status',
  expense_payout: 'expense payout',
};
export const categoryLabel = (c: string) => lookup(CATEGORY, c).toLowerCase();

const PARTY: Record<string, string> = {
  customer: 'customer',
  driver: 'driver',
  site_contact: 'site',
  handoff_contact: 'handover contact',
  operator: 'operations',
  agent: 'agent',
  system: 'system',
};
export const partyLabel = (c: string | null | undefined) => (c ? lookup(PARTY, c).toLowerCase() : 'several people');

const CHANNEL: Record<string, string> = {
  email: 'email', internal_note: 'internal note', support_chat: 'support chat', driver_chat: 'driver chat',
  site_call: 'call with the site', customer_email: 'email', whatsapp: 'WhatsApp', site_chat: 'site chat',
  driver_app_chat: 'driver app', app_chat: 'app chat', case_workspace: 'case thread',
};
export const channelLabel = (c: string) => lookup(CHANNEL, c).toLowerCase();

const PROPOSAL_STATUS: Record<string, string> = {
  PENDING_REVIEW: 'Waiting for your yes',
  APPROVED_AWAITING_EXECUTION: 'Approved, agent still to act',
  EXECUTED: 'Done, change recorded',
  REJECTED: 'Rejected',
  FAILED: 'Failed, needs a person',
};
export const proposalStatusLabel = (c: string) => lookup(PROPOSAL_STATUS, c);

const ALERT_STATUS: Record<string, string> = {
  OPEN: 'Open',
  ACKNOWLEDGED: 'Seen, still open',
  RESOLVED: 'Resolved',
  DISMISSED: 'Dismissed',
};
export const alertStatusLabel = (c: string) => lookup(ALERT_STATUS, c);

const SOURCE: Record<string, string> = {
  MANAGED_SITE_PROFILE: 'standard site profile',
  CUSTOMER_ORDER_INPUT: 'customer, on the order',
  CUSTOMER_AND_HANDOFF_CONTACT: 'customer and handover contact',
  HANDOFF_ACCESS_REPLY: 'handover contact’s reply',
  SITE_CONTACT_REPLY: 'site’s reply',
  DIRECT_HANDOFF_CONTACT_REPLY: 'handover contact, directly',
  SITE_ACCESS_REPLY: 'site’s reply',
  SITE_CONTACT: 'site contact',
  CUSTOMER: 'customer',
  OPS: 'operations',
  SYSTEM: 'system estimate',
  SITE: 'site',
  CUSTOMER_AGREEMENT: 'customer agreement',
  driver_app: 'driver app',
};
export const sourceLabel = (c: string | null | undefined) => lookup(SOURCE, c).toLowerCase();

const RES_KIND: Record<string, string> = { FERRY: 'Ferry', FLIGHT: 'Flight', HOTEL: 'Hotel', TRAIN: 'Train' };
export const reservationKindLabel = (c: string) => lookup(RES_KIND, c);

const DOC_KIND: Record<string, string> = {
  CMR: 'Transport document (CMR)',
  RELEASE_AUTHORITY: 'Release authority',
  SIGNED_HANDOVER: 'Signed handover',
  CONDITION_PHOTO: 'Condition photo',
};
export const documentKindLabel = (c: string) => lookup(DOC_KIND, c);

const DOC_STATUS: Record<string, string> = {
  SIGNED: 'signed', VERIFIED: 'verified', PREPARED: 'prepared, not signed', MISSING: 'missing', REQUESTED: 'requested',
};
export const documentStatusLabel = (c: string) => lookup(DOC_STATUS, c).toLowerCase();

const PROOF_KIND: Record<string, string> = {
  PICKUP_PHOTOS: 'Pickup photos', DELIVERY_PHOTOS: 'Delivery photos', TRADE_IN_PICKUP_PHOTOS: 'Trade-in pickup photos',
  MESSAGE_PHOTO: 'Photo sent in a message', SITE_VISIT_PHOTO: 'Site visit photo',
  TRADE_IN_DELIVERY_PHOTOS: 'Trade-in delivery photos', YARD_ARRIVAL_PHOTOS: 'Yard arrival photos',
  YARD_RELEASE_PHOTOS: 'Yard release photos', KEY_PICKUP_PHOTOS: 'Key photos at pickup', KEY_DELIVERY_PHOTOS: 'Key photos at delivery',
};
export const proofKindLabel = (c: string) => lookup(PROOF_KIND, c);

const PROOF_STATUS: Record<string, string> = { APPROVED: 'approved', SUBMITTED: 'sent, not reviewed', REJECTED: 'rejected', REQUIRED: 'still needed', WAIVED: 'waived' };
export const proofStatusLabel = (c: string) => lookup(PROOF_STATUS, c).toLowerCase();

const EVENT: Record<string, string> = {
  'order.created': 'Order created',
  'plan.created': 'Route planned',
  'availability.confirmed': 'Pickup availability confirmed',
  'plan.activated': 'Route made current',
  'offer.published': 'Offered to drivers',
  'offer.accepted': 'A driver took the offer',
  'assignment.booked': 'Driver booked',
  'order.status_changed': 'Order stage changed',
  'assignment.started': 'Driver started',
  'vehicle.picked_up': 'Car collected',
  'proof.submitted': 'Photos sent',
  'expense.submitted': 'Expense sent',
  'expense.reviewed': 'Expense reviewed',
  'vehicle.custody_reported': 'Driver reported where the car is parked',
  'vehicle.delivered': 'Car delivered',
  'assignment.completed': 'Driver finished the job',
  'plan.completed': 'Route completed',
  'proof.approved': 'Photos approved',
  'travel.booked': 'Travel booked',
  'alert.raised': 'Alert raised',
  'alert.resolved': 'Alert resolved',
  'alert.acknowledged': 'Alert seen by a person',
  'incident.opened': 'Incident opened',
  'offer.withdrawn': 'Offer withdrawn',
  'travel.check_in_rejected': 'Ferry check-in refused at the gate',
  'travel.rebooked': 'Travel rebooked',
  'travel.check_in_confirmed': 'Ferry check-in confirmed at the gate',
  'pickup.attempted': 'Driver tried to collect',
  'pickup.vehicle_not_found': 'Car not found at pickup',
  'site_visit.arrived': 'Driver arrived at the site',
  'order.cancelled': 'Order cancelled',
  'assignment.cancelled': 'Driver booking cancelled',
  'plan.replaced': 'Route replaced',
  'document.verified': 'Document verified',
  'work_item.opened': 'Follow-up opened',
  'work.opened': 'Follow-up opened',
  'endpoint.access_confirmed': 'Access confirmed',
  'endpoint.contact_confirmed': 'Contact confirmed',
  'message.sent': 'Message sent',
  'delivery.promise_revised': 'Delivery promise changed',
  'delivery.delay_reported': 'Delay reported',
};
export const eventLabel = (c: string) => lookup(EVENT, c);

const ACTOR: Record<string, string> = {
  customer: 'Customer', operator: 'Operations', agent: 'Agent', driver: 'Driver', system: 'System',
  handoff_contact: 'Handover contact', site_contact: 'Site',
};
export const actorLabel = (c: string) => lookup(ACTOR, c);

export const RISK_LABEL = ['Low', 'Medium', 'High', 'Critical'] as const;

export const GROUP_LABEL = {
  decide: 'Decide now',
  follow: 'Follow up',
  waiting: 'Waiting on others',
} as const;

export const ACTION_LABEL = {
  approve: 'Approve',
  change: 'Change',
  reject: 'Reject',
  retry: 'Retry',
  take: 'I’ll take it',
  already_sorted: 'Already sorted',
  done: 'Mark handled',
  link: 'It’s this order',
  not_this: 'Not this one',
} as const;

/** Failed proposals use "I'll handle it" instead of "I'll take it". */
export function actionLabel(action: keyof typeof ACTION_LABEL, failed = false): string {
  if (failed && action === 'take') return 'I’ll handle it';
  return ACTION_LABEL[action];
}

export const AUTONOMY_LEVEL = {
  ask_first: 'Ask first',
  act_then_tell: 'Act, then tell',
  on_its_own: 'On its own',
} as const;

export const AUTONOMY_KIND: Record<string, { title: string; detail: string }> = {
  read_and_ask: { title: 'Read records and ask drivers or sites', detail: 'Looking things up and asking questions never needs a yes.' },
  customer_message: { title: 'Message a customer', detail: 'An agent never contacts anyone who pays us. It drafts; a person sends.' },
  book_travel: { title: 'Book or change travel', detail: 'Ferries, trains, flights and hotels for drivers.' },
  change_date: { title: 'Change a pickup or delivery date', detail: 'Any change to a slot or a promise.' },
  approve_cost: { title: 'Approve a cost', detail: 'Expenses, fees and anything that spends money.' },
  change_assignment: { title: 'Change who drives', detail: 'Book, replace or release a driver.' },
  resolve_alert: { title: 'Close an alert or record a finding', detail: 'Marking a signal resolved or recording who caused what.' },
};

export const CERTAINTY_HELP = {
  confirmed: 'Checked for this order by a named source',
  stated: 'Someone said so; not checked for this order',
  planned: 'What we intend; nothing has happened yet',
  quote: 'A price or seat seen at a time; not booked',
  missing: 'Not recorded',
} as const;

/** Attachment kinds share names with proofs and documents. */
export function attachmentKindLabel(kind: string): string {
  return PROOF_KIND[kind] ?? DOC_KIND[kind] ?? humanize(kind);
}

export const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// Shapes of the packet records this app reads. Only the fields we use are
// typed; every record also keeps the rest of its JSON untouched.

export type Iso = string;
export type Ref = { id: string; table: string };

export interface RecordRow {
  collection: string;
  id: string;
  order_id: string | null;
  data: Record<string, unknown>;
}

export interface Order {
  id: string;
  reference: string;
  customer_id: string;
  customer_reference?: string | null;
  status: 'NEW' | 'WAITING_FOR_PICKUP' | 'IN_TRANSIT' | 'DELIVERED';
  readiness_status: 'CONFIRMED' | 'PREPARING';
  route_kind: 'DOMESTIC' | 'IMPORT';
  display_lane?: string;
  active_plan_id: string | null;
  pickup_address_id: string;
  delivery_address_id: string;
  pickup_site_id: string | null;
  delivery_site_id: string | null;
  cancelled_at: Iso | null;
  cancellation_reason?: string | null;
  created_at: Iso;
  updated_at: Iso;
}

export interface OrderItem { id: string; order_id: string; role: 'PRIMARY' | 'TRADE_IN'; vehicle_id: string; cmr_mode?: string }
export interface Vehicle { id: string; make: string | null; model: string | null; model_year: number | null; registration: string | null; synthetic_vin: string | null; fuel?: string }
export interface Customer { id: string; name: string; country: string; account_tier?: string }
export interface Driver { id: string; display_name: string; home_city?: string; home_country?: string }
export interface Operator { id: string; title: string; kind: string }
export interface Agent { id: string; title: string; scope: string; kind: string }

export interface Address {
  id: string; name: string | null; address_line1: string | null; city: string | null; country: string | null;
  kind: string; timezone: string; managed_site_id: string | null; raw_input?: string | null;
}
export interface Site { id: string; name: string; city: string; kind: string; timezone: string; requires_signed_release?: boolean }

export interface Plan { id: string; order_id: string; status: string; version: number; activated_at?: Iso | null }
export interface Point { id: string; plan_id: string; role: 'PICKUP' | 'DELIVERY' | 'TRANSFER'; order_boundary?: string; address_id: string; site_id: string | null; sequence: number }
export interface Segment { id: string; plan_id: string; order_item_id: string; status: string; from_point_id: string; to_point_id: string; transport_mode: string; distance_km?: number }

export interface TimeWindow {
  id: string; order_id: string; point_id: string; purpose: string; is_selected: boolean; source: string;
  start_at: Iso; end_at: Iso; timezone: string; commitment_deadline_at?: Iso | null; deadline_source?: string | null;
}

export interface Offer { id: string; order_id: string; status: 'PUBLISHED' | 'ACCEPTED' | 'WITHDRAWN'; segment_ids: string[]; order_ids?: string[]; published_at: Iso; expires_at?: Iso | null; fee_cents: number }

export interface Assignment {
  id: string; order_id: string; driver_id: string; status: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
  segment_ids: string[]; accepted_at: Iso; started_at: Iso | null; completed_at: Iso | null; cancelled_at: Iso | null;
}

export interface Step {
  id: string; order_id: string; assignment_id: string; kind: string; status: 'PLANNED' | 'COMPLETED' | 'UNVERIFIED';
  scheduled_start_at: Iso | null; completed_at: Iso | null; cancelled_at: Iso | null; title: string;
}

export interface Reservation {
  id: string; order_id: string; assignment_id: string; kind: 'FERRY' | 'FLIGHT' | 'HOTEL' | 'TRAIN'; status: string;
  booked_at: Iso; departure_at: Iso; expected_arrival_at?: Iso; booking_reference?: string; route_label?: string;
  from_city?: string; to_city?: string; city?: string; provider?: string;
  boarding_confirmation?: string; check_in_confirmation?: string; cancelled_at?: Iso | null; check_in_cutoff_at?: Iso | null;
}

export interface TravelOption {
  id: string; order_id: string; assignment_id?: string; kind: string; status: 'AVAILABLE_QUOTE' | 'SOLD_OUT';
  provider: string; from_city: string; to_city: string; departure_at: Iso; arrival_at: Iso; checked_at: Iso;
  quote_cents: number | null; currency: string; capacity_note?: string;
}

export interface Tracking {
  id: string; order_id: string; assignment_id: string; observed_at: Iso; received_at: Iso; source: string;
  progress_fraction?: number | null; distance_remaining_km?: number | null; estimated_delivery_at?: Iso | null;
  location_quality?: string; observation_kind?: string;
}

export interface Alert {
  id: string; order_id: string; signal: string; severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED'; summary: string; triggered_at: Iso;
  owner?: string | null; next_action?: string | null; acknowledged_at?: Iso | null; acknowledgement_reason?: string | null;
  conversation_id?: string | null; assignment_id?: string | null; resolved_at?: Iso | null;
}

export interface Incident {
  id: string; order_id: string; kind: string; status: string; owner: string | null; opened_at: Iso;
  resolved_at: Iso | null; reported_symptom?: string; reported_stop_text?: string; recovery_decision?: string;
}

export interface WorkItem {
  id: string; order_id: string; kind: string; status: string; owner: string | null; priority: 'high' | 'routine';
  due_at: Iso | null; next_action: string | null; summary: string; opened_at: Iso; closed_at: Iso | null;
  created_by: string; related_order_ids?: string[];
}

export interface Conversation {
  id: string; order_id: string; status: 'OPEN' | 'CLOSED'; category: string; channel: string;
  counterparty_type: string | null; counterparty_id?: string | null; counterparty_name_snapshot?: string;
  waiting_on?: string | null; owner?: string | null; next_check_at?: Iso | null;
  related_order_ids?: string[]; started_at: Iso; updated_at: Iso;
}

export interface Message {
  id: string; conversation_id: string; order_id: string; author_id: string | null; author_type: string;
  author_name_snapshot?: string; recipient_type: string; channel: string; visibility: 'PUBLIC' | 'INTERNAL';
  authored_at: Iso; body: string;
}

export type ProposalStatus = 'PENDING_REVIEW' | 'APPROVED_AWAITING_EXECUTION' | 'EXECUTED' | 'REJECTED' | 'FAILED';

export interface Proposal {
  id: string; order_id: string; command: string; status: ProposalStatus; summary: string; rationale: string;
  proposed_by_agent_id: string; target_type: string; target_id: string; created_at: Iso; alert_id: string | null;
  proposed_payload: Record<string, unknown>;
  dependency: { execution_policy?: string; checked_at?: Iso; basis_event_id?: string };
  evidence_refs: Ref[];
  review: null | { decision: 'APPROVED' | 'EDITED' | 'REJECTED'; decision_note: string; reviewed_at: Iso; reviewer_id: string; final_payload: Record<string, unknown> };
  execution: null | { attempted_at: Iso; status: 'SUCCEEDED' | 'FAILED'; error: string | null; effect_event_ids: string[] };
}

export interface EndpointDetail {
  id: string; order_id: string; boundary: 'PICKUP' | 'DELIVERY'; address_id: string; point_id?: string; site_id: string | null;
  access_instruction: string | null; access_status: 'CONFIRMED' | 'NEEDS_VERIFICATION';
  contact_name: string | null; contact_role: string | null; contact_handle: string | null; contact_status: 'CONFIRMED' | 'UNCONFIRMED';
  last_confirmed_at: Iso | null; last_confirmed_source: string | null; stated_by: string; stated_at: Iso;
}

export interface EndpointClaim {
  id: string; order_id: string; claim: string; field: string; source_type: string; recorded_at: Iso;
  resolution_status: string | null; resolved_at: Iso | null;
}

export interface CustodyAsset {
  id: string; order_id: string; kind: string; label: string; status: string; next_action: string | null;
  followup_due_at: Iso | null; followup_owner: string | null; holder_role: string; holder_basis: string;
  physical_handover_verified_at: Iso | null; related_order_id?: string | null;
}

export interface Document {
  id: string; order_id: string; kind: string; status: string; medium?: string; signature_scope?: string;
  updated_at: Iso; required?: boolean;
}

export interface Proof { id: string; order_id: string; kind: string; status: string; submitted_at?: Iso | null; reviewed_at?: Iso | null; review_note?: string | null; file_count?: number }

export interface OpEvent {
  id: string; order_id: string; command: string; recorded_at: Iso; actor_id: string | null; actor_type: string;
  source: string; target_type: string; target_id: string; from_state: string | null; to_state: string | null;
  changes?: Record<string, unknown>;
}

export interface InboxThread {
  id: string; status: 'OPEN' | 'CLOSED'; link_state: string; candidate_order_ids: string[]; linked_order_ids: string[];
  candidate_basis: string; counterparty_type: string; counterparty_id: string; category: string; channel: string;
  owner: string | null; waiting_on: string | null; opened_at: Iso; updated_at: Iso;
}

export interface InboxMessage {
  id: string; thread_id: string; author_id: string; author_type: string; authored_at: Iso; body: string;
  visibility: 'PUBLIC' | 'INTERNAL'; channel: string;
}

export interface Notification { id: string; order_id: string; activity: string; actor_id: string | null; occurred_at: Iso; preview: string; destination: string }

export interface Attachment { id: string; order_id: string; related_record_type: string; related_record_id: string; kind: string; file_name: string; content_type: string; captured_at?: Iso; evidence_note?: string }

/** A decision a person made in this app, read back from the `decisions` table. */
export interface Decision {
  id: string;
  order_id: string;
  target_type: string;
  target_id: string;
  action: ActionKind;
  note: string | null;
  decided_by: string;
  decided_at: Iso;
  effects: OutcomeStep[];
  undone_at: Iso | null;
}

export type ActionKind =
  | 'approve' | 'change' | 'reject'
  | 'retry' | 'take' | 'already_sorted'
  | 'done'
  | 'link' | 'not_this';

/** One numbered line of "what will happen". */
export interface OutcomeStep {
  text: string;
  /** Who does it. A step left to a person is marked "on you" in the UI. */
  by: 'agent' | 'person' | 'system';
}

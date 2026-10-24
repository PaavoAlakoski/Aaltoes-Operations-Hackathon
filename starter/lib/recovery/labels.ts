// Plain words for codes. The API keeps the raw codes; the interface shows these labels.

export const RECOVERY_SIGNALS = ["POSITIONING_AT_RISK", "DRIVER_AVAILABILITY_RISK"] as const
export const OPEN_ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const

export function humanize(code: string): string {
  const text = code.replace(/[._]/g, " ").trim().toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const SIGNAL_LABELS: Record<string, string> = {
  POSITIONING_AT_RISK: "Driver can't reach the pickup",
  DRIVER_AVAILABILITY_RISK: "Driver availability at risk",
  CONDITION_CLAIM: "Condition claim",
  CONDITION_CLAIM_REVIEW: "Condition claim review",
  DELIVERY_ACCESS_RISK: "Delivery access at risk",
  DELIVERY_PROMISE_UNACHIEVABLE: "Delivery promise at risk",
  EMPTY_PICKUP: "Empty pickup attempt",
  FERRY_CONNECTION_RISK: "Ferry connection at risk",
  FERRY_SOLD_OUT: "Ferry sold out",
  FERRY_TRACKING_GAP_CONTEXT: "Ferry tracking gap",
  FR_IMPORT_TRAVEL_DECISION: "Travel decision needed",
  INVOICE_REFERENCE_QUERY: "Invoice reference query",
  PICKUP_PROOF_REJECTED: "Pickup proof rejected",
  PROOF_REVIEW: "Proof review",
  RELEASE_DOCUMENT_UNCLEAR: "Release document unclear",
  SAFETY_STOP: "Safety stop",
  SITE_ACCESS_CONFLICT: "Site access conflict",
  SITE_ACCESS_UNCONFIRMED: "Site access not confirmed",
  TRACKING_GAP: "No recent position",
}

export function signalLabel(signal: string): string {
  return SIGNAL_LABELS[signal] ?? humanize(signal)
}

const COMMAND_LABELS: Record<string, string> = {
  "order.created": "Order received",
  "order.status_changed": "Status changed",
  "order.readiness_assessed": "Readiness checked",
  "order.cancelled": "Order cancelled",
  "order.cancellation_confirmed": "Cancellation confirmed",
  "order.item_added": "Car added to order",
  "plan.created": "Route planned",
  "plan.activated": "Route confirmed",
  "plan.replaced": "Route replaced",
  "plan.completed": "Route completed",
  "plan.cancelled": "Route cancelled",
  "availability.confirmed": "Pickup availability confirmed",
  "pickup_window.selected": "Pickup slot chosen",
  "pickup.window_revised": "Pickup window changed",
  "pickup.attempted": "Pickup attempted",
  "pickup.vehicle_not_found": "Car not found at pickup",
  "delivery_window.selected": "Delivery window chosen",
  "delivery.promise_recorded": "Delivery promise recorded",
  "delivery.promise_revised": "Delivery promise changed",
  "delivery.delay_reported": "Delay reported",
  "offer.published": "Job offered to drivers",
  "offer.accepted": "Driver accepted the job",
  "offer.withdrawn": "Job offer withdrawn",
  "offer.booking_cutoff_passed": "Booking cutoff passed",
  "assignment.booked": "Driver booked",
  "assignment.started": "Driver started the job",
  "assignment.completed": "Driver finished the job",
  "assignment.cancelled": "Driver assignment cancelled",
  "vehicle.picked_up": "Car picked up",
  "vehicle.delivered": "Car delivered",
  "vehicle.custody_reported": "Custody reported",
  "travel.booked": "Travel booked",
  "travel.rebooked": "Travel rebooked",
  "travel.amendment_requested": "Travel change requested",
  "travel.check_in_confirmed": "Ferry check-in confirmed",
  "travel.check_in_rejected": "Ferry check-in rejected",
  "travel.arrival_reported": "Arrival reported",
  "expense.submitted": "Expense submitted",
  "expense.reviewed": "Expense reviewed",
  "expense.auto_recorded": "Receipt recorded",
  "expense.superseded": "Expense corrected",
  "proof.submitted": "Proof submitted",
  "proof.approved": "Proof approved",
  "proof.require": "Proof requested",
  "proof.review": "Proof reviewed",
  "document.verified": "Document checked",
  "alert.raised": "Alert raised",
  "alert.acknowledged": "Alert acknowledged",
  "alert.resolved": "Alert resolved",
  "alert.assessed": "Alert reviewed",
  "alert.owner_assigned": "Alert owner assigned",
  "alert.followup_scheduled": "Follow-up scheduled",
  "work_item.opened": "Check opened",
  "work.opened": "Work opened",
  "incident.opened": "Incident opened",
  "support.request_received": "Support request received",
  "support.answer_recorded": "Support answer recorded",
  "message.sent": "Message sent",
  "endpoint.access_confirmed": "Site access confirmed",
  "endpoint.contact_confirmed": "Site contact confirmed",
  "endpoint.claim_recorded": "Site statement recorded",
  "endpoint.claim_resolved": "Site statement resolved",
  "market.offer_assessed": "Offer reviewed",
  "market.fee_decided": "Offer fee decided",
}

export function commandLabel(command: string): string {
  return COMMAND_LABELS[command] ?? humanize(command.split(".").slice(-1)[0] ?? command)
}

const PROPOSAL_COMMAND_LABELS: Record<string, string> = {
  "assignment.review_positioning": "Review the driver's way to the pickup",
  "assignment.prepare_backup": "Prepare a backup driver",
  "pickup.verify_identity": "Check the car's identity with the site",
}

export function proposalCommandLabel(command: string): string {
  return PROPOSAL_COMMAND_LABELS[command] ?? humanize(command)
}

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  PENDING_REVIEW: "Waiting for review",
  APPROVED_AWAITING_EXECUTION: "Approved, not carried out yet",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  EXECUTED: "Carried out",
  FAILED: "Failed",
}

export function proposalStatusLabel(status: string): string {
  return PROPOSAL_STATUS_LABELS[status] ?? humanize(status)
}

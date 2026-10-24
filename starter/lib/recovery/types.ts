// Shared shapes for the recovery feature. Client-safe: no server imports here.

export type SourceRef = { table: string; id: string }
export type Money = { cents: number; currency: string }
export type Window = { start: string; end: string; timezone: string; source: SourceRef }

export type RecoverySignal = "POSITIONING_AT_RISK" | "DRIVER_AVAILABILITY_RISK"
export type DriverStatus = "available" | "booked" | "on_job"
export type Location = {
  city: string
  country: string
  basis: "PLANNED_RELEASE_CITY" | "HOME_CITY"
  confirmed: false
  note: string
}

export type OrderRecord = {
  id: string
  reference: string
  status: string
  carMake: string
  carModel: string
  /** The paying customer. Shown to people, never contacted by the agent. */
  customerName: string
  /** The place where the car waits: the pickup site, else the one-off address. */
  dealerName: string
  dealerCity: string
  dealerCountry: string
  dealerTimezone: string | null
  /** Closing time on the pickup slot's local weekday, from the site's recorded hours. */
  dealerClosingTime: string | null
  dealerHoursNote: string | null
  deliveryName: string
  deliveryCity: string
  deliveryCountry: string
  pickupSlot: Window | null
  /** The customer's wider availability for pickup. */
  pickupAvailability: Window | null
  deliveryPromise: Window | null
  sources: SourceRef[]
}

export type DriverRecord = {
  id: string
  name: string
  homeCity: string
  homeCountry: string
  status: DriverStatus
  statusBasis: string
  currentLocation: Location
  earliestAvailableAt: string | null
  /** Reference of the job the driver is working on now, if any. */
  progressRef: string | null
  sources: SourceRef[]
}

export type EventKind = "alert" | "message" | "operation"
export type EventRecord = {
  orderId: string
  timestamp: string
  kind: EventKind
  eventType: string
  message: string
  actor: string
  source: SourceRef
}

export type Positioning = {
  plannedReleaseCity: string | null
  plannedReleaseCountry: string | null
  /** The driver's reported time, else the estimate from the previous duty. */
  earliestAvailableAt: string | null
  driverReportMessageId: string | null
}

export type AssignmentRecord = {
  id: string
  orderId: string
  orderRef: string
  driverId: string
  status: string
  fee: Money
  positioning: Positioning | null
  sources: SourceRef[]
}

export type AlertRecord = {
  id: string
  orderId: string
  signal: string
  label: string
  severity: string
  status: string
  summary: string
  triggeredAt: string
  acknowledgedAt: string | null
  acknowledgementReason: string | null
  owner: string | null
  assignmentId: string | null
  driverId: string | null
  nextAction: string | null
  sources: SourceRef[]
}

export type OfferRecord = {
  id: string
  orderId: string
  orderRef: string
  status: string
  type: string
  visibility: string
  fee: Money
  publishedAt: string
  expiresAt: string
  acceptedAt: string | null
  withdrawnAt: string | null
  pickupCity: string | null
  pickupCountry: string | null
  deliveryCity: string | null
  deliveryCountry: string | null
  pickupSlot: Window | null
  sources: SourceRef[]
}

export type ProposalRecord = {
  id: string
  orderId: string
  alertId: string | null
  command: string
  commandLabel: string
  summary: string
  rationale: string
  status: string
  statusLabel: string
  createdAt: string
  review: { decision: string; decisionNote: string | null; reviewedAt: string | null; reviewer: string | null } | null
  sources: SourceRef[]
}

export type RecoveryCase = {
  id: string
  reference: string
  carMake: string
  carModel: string
  signal: RecoverySignal
  reason: string
  pickupCity: string
  pickupSlot: { start: string; end: string; timezone: string } | null
  driverName: string | null
  alertId: string
}

export type CaseList = {
  snapshotAt: string
  checkedOrders: number
  cases: RecoveryCase[]
}

export type NodeKind = "offer" | "person" | "release" | "explain" | "empty"

export type Option = { id: string; label: string; detail: string; sources: SourceRef[] }

export type MoveNode = {
  id: string
  lane: "car" | "driver"
  kind: NodeKind
  title: string
  body: string
  options: Option[]
  actionLabel: string | null
  /** Shown beside a person-only action, e.g. "Only a person can do this". */
  note: string | null
  dependsOn: string[]
  lockedText: string | null
  /** Written to the decisions log when the node is approved or marked done. */
  log: string
  /** Shown once the node is done. States what is and is not true now. */
  doneNote: string
  quote: { text: string; at: string; recordType: string; who: string; source: SourceRef } | null
  sources: SourceRef[]
}

export type KeyEvent = { at: string; recordType: string; who: string; text: string; source: SourceRef }

export type RecoveryPlan = {
  snapshotAt: string
  orderId: string
  reference: string
  signal: RecoverySignal
  car: { make: string; model: string }
  customerName: string
  pickup: {
    name: string
    city: string
    country: string
    timezone: string | null
    closingTime: string | null
    hoursNote: string | null
  }
  slot: Window | null
  availability: Window | null
  driver: { id: string; name: string; homeCity: string; location: Location; earliestAvailableAt: string | null }
  root: { headline: string; summary: string; keyEvents: KeyEvent[]; priorWork: { summary: string; statusLabel: string; decisionNote: string | null; source: SourceRef }[] }
  carBranch: MoveNode[]
  driverBranch: MoveNode[]
  alternative: { text: string; source: SourceRef } | null
  caveats: string[]
}

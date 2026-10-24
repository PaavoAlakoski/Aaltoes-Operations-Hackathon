import "server-only"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { commandLabel, humanize, proposalCommandLabel, proposalStatusLabel, signalLabel } from "./labels"
import type {
  AlertRecord,
  AssignmentRecord,
  DriverRecord,
  DriverStatus,
  EventRecord,
  Location,
  OfferRecord,
  OrderRecord,
  ProposalRecord,
  Window,
} from "./types"

export type Dataset = {
  snapshotAt: string
  orders: OrderRecord[]
  drivers: DriverRecord[]
  events: EventRecord[]
  alerts: AlertRecord[]
  offers: OfferRecord[]
  assignments: AssignmentRecord[]
  proposals: ProposalRecord[]
}

export const DATASET_DIR = process.env.DATASET_DIR ?? path.resolve(process.cwd(), "../dataset/data")

// Raw rows as written in the JSONL files. Only the fields the recovery feature reads are typed.
type Row = { id: string }
interface RawOrder extends Row { reference: string; status: string; customer_id: string; pickup_address_id: string; pickup_site_id: string | null; delivery_address_id: string; delivery_site_id: string | null }
interface RawItem extends Row { order_id: string; role: string; vehicle_id: string }
interface RawVehicle extends Row { make: string; model: string }
interface RawCustomer extends Row { name: string }
interface RawSite extends Row { name: string; timezone: string; opening_hours: Record<string, unknown> | null }
interface RawAddress extends Row { name: string; city: string; country: string; timezone: string | null }
interface RawDriver extends Row { display_name: string; home_city: string; home_country: string; active?: boolean }
interface RawPositioning {
  planned_release_city?: string | null
  planned_release_country?: string | null
  driver_reported_earliest_departure_at?: string | null
  earliest_positioning_departure_at?: string | null
  driver_report_message_id?: string | null
}
interface RawAssignment extends Row { order_id: string; driver_id: string; status: string; fee_cents: number; currency: string; positioning?: RawPositioning | null }
interface RawAlert extends Row {
  order_id: string; signal: string; status: string; severity: string; summary: string; triggered_at: string
  acknowledged_at?: string | null; acknowledgement_reason?: string | null; owner?: string | null
  assignment_id?: string | null; driver_report_message_id?: string | null; next_action?: string | null
}
interface RawMessage extends Row {
  order_id: string | null; author_id: string | null; author_type: string; recipient_type: string
  channel: string; visibility: string; body: string; authored_at: string
}
interface RawOperational extends Row {
  order_id: string | null; command: string; actor_id: string | null; actor_type: string | null
  recorded_at: string; to_state: string | null; changes: Record<string, unknown> | null
}
interface RawOffer extends Row {
  order_id: string; status: string; type: string; visibility: string; fee_cents: number; currency: string
  published_at: string; expires_at: string; accepted_at?: string | null; withdrawn_at?: string | null
}
interface RawWindow extends Row {
  order_id: string; point_id: string; purpose: string; source: string; start_at: string; end_at: string; timezone: string; is_selected: boolean
}
interface RawProposal extends Row {
  order_id: string; alert_id?: string | null; command: string; summary: string; rationale?: string | null; status: string; created_at: string
  review: { decision: string; decision_note?: string | null; reviewed_at?: string | null; reviewer_id?: string | null } | null
}
interface RawNamed extends Row { title: string }

const ACTIVE = new Set(["ASSIGNED", "IN_PROGRESS"])

let cache: Promise<Dataset> | null = null

/** Loads the packet once per server process. Reads only files; no database. */
export function loadDataset(): Promise<Dataset> {
  if (!cache) cache = build().catch((error: unknown) => { cache = null; throw error })
  return cache
}

async function readRows<T>(name: string): Promise<T[]> {
  const text = await readFile(path.join(DATASET_DIR, `${name}.jsonl`), "utf8")
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as T)
}

function byId<T extends Row>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]))
}

function groupBy<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    if (k === null) continue
    groups.set(k, [...(groups.get(k) ?? []), row])
  }
  return groups
}

const ms = (value: string) => Date.parse(value)

function windowOf(row: RawWindow | undefined): Window | null {
  if (!row) return null
  return { start: row.start_at, end: row.end_at, timezone: row.timezone, source: { table: "time_windows", id: row.id } }
}

// Closing time on the local weekday of the pickup slot. The site's recorded hours give "09:00-17:00" or null for a closed day.
function closingFor(site: RawSite | undefined, slot: Window | null): { time: string | null; note: string | null } {
  if (!slot) return { time: null, note: "No pickup slot recorded" }
  if (!site?.opening_hours) return { time: null, note: "Hours not recorded" }
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: slot.timezone, weekday: "short" }).format(new Date(slot.start))
  const key = weekday === "Sat" ? "sat" : weekday === "Sun" ? "sun" : "mon_fri"
  const hours = site.opening_hours[key]
  if (hours === undefined) return { time: null, note: "Hours not recorded" }
  if (hours === null) return { time: null, note: "Closed that day in the site's record" }
  if (typeof hours !== "string") return { time: null, note: "Hours not recorded" }
  const end = hours.split("-")[1]?.trim()
  return end ? { time: end, note: null } : { time: null, note: "Hours not recorded" }
}

function messageLabel(message: RawMessage): string {
  if (message.visibility === "INTERNAL" || message.channel === "internal_note") return "Ops note"
  switch (message.author_type) {
    case "driver": return "Driver message"
    case "customer": return "Customer message"
    case "site_contact": return "Site message"
    case "handoff_contact": return "Handoff contact message"
    case "agent": return "Agent message"
    default:
      if (message.recipient_type === "customer") return "Message to customer"
      if (message.recipient_type === "driver") return "Message to driver"
      return "Operator message"
  }
}

function operationMessage(row: RawOperational): string {
  const decision = row.changes?.decision
  if (typeof decision === "string") return decision
  return row.to_state ? `Now ${humanize(row.to_state).toLowerCase()}` : ""
}

async function build(): Promise<Dataset> {
  const [manifest, orderRows, itemRows, vehicleRows, customerRows, siteRows, addressRows, driverRows, assignmentRows, alertRows, messageRows, eventRows, offerRows, windowRows, proposalRows, operatorRows, agentRows] = await Promise.all([
    readFile(path.join(DATASET_DIR, "manifest.json"), "utf8").then((text) => JSON.parse(text) as { snapshot_at: string }),
    readRows<RawOrder>("orders"),
    readRows<RawItem>("order_items"),
    readRows<RawVehicle>("vehicles"),
    readRows<RawCustomer>("customers"),
    readRows<RawSite>("sites"),
    readRows<RawAddress>("addresses"),
    readRows<RawDriver>("drivers"),
    readRows<RawAssignment>("work_assignments"),
    readRows<RawAlert>("alerts"),
    readRows<RawMessage>("messages"),
    readRows<RawOperational>("operational_events"),
    readRows<RawOffer>("market_offers"),
    readRows<RawWindow>("time_windows"),
    readRows<RawProposal>("agent_proposals"),
    readRows<RawNamed>("operators"),
    readRows<RawNamed>("agents"),
  ])

  const snapshotAt = manifest.snapshot_at
  const vehicles = byId(vehicleRows)
  const customers = byId(customerRows)
  const sites = byId(siteRows)
  const addresses = byId(addressRows)
  const rawDrivers = byId(driverRows)
  const operators = byId(operatorRows)
  const agents = byId(agentRows)
  const windowsByOrder = groupBy(windowRows, (row) => row.order_id)
  const rawOrders = byId(orderRows)
  const refOf = (orderId: string) => rawOrders.get(orderId)?.reference ?? orderId

  const operatorTitle = (id: string) => operators.get(id)?.title ?? humanize(id)

  function actorName(type: string | null, id: string | null): string {
    if (type === "driver") return rawDrivers.get(id ?? "")?.display_name ?? "Driver"
    if (type === "customer") return customers.get(id ?? "")?.name ?? "Customer"
    if (type === "operator") return id ? operatorTitle(id) : "Operations"
    if (type === "agent") return agents.get(id ?? "")?.title ?? "Agent"
    if (type === "site_contact") return `${sites.get(id ?? "")?.name ?? "Site"} contact`
    if (type === "handoff_contact") return "Handoff contact"
    return "System"
  }

  const orders: OrderRecord[] = orderRows.map((order) => {
    const item = itemRows.find((row) => row.order_id === order.id && row.role === "PRIMARY") ?? itemRows.find((row) => row.order_id === order.id)
    const vehicle = item ? vehicles.get(item.vehicle_id) : undefined
    const pickupAddress = addresses.get(order.pickup_address_id)
    const deliveryAddress = addresses.get(order.delivery_address_id)
    const pickupSite = order.pickup_site_id ? sites.get(order.pickup_site_id) : undefined
    const deliverySite = order.delivery_site_id ? sites.get(order.delivery_site_id) : undefined
    const windows = windowsByOrder.get(order.id) ?? []
    const slotRow = windows.find((row) => row.purpose === "SELECTED_PICKUP_SLOT" && row.is_selected)
    const slot = windowOf(slotRow)
    const availabilityRow = windows.find((row) => row.purpose === "PICKUP_AVAILABILITY" && row.point_id === slotRow?.point_id)
      ?? windows.find((row) => row.purpose === "PICKUP_AVAILABILITY")
    const promiseRow = windows.find((row) => row.purpose === "CUSTOMER_DELIVERY_PROMISE" && row.is_selected)
    const closing = closingFor(pickupSite, slot)
    return {
      id: order.id,
      reference: order.reference,
      status: order.status,
      carMake: vehicle?.make ?? "Unknown make",
      carModel: vehicle?.model ?? "",
      customerName: customers.get(order.customer_id)?.name ?? "Customer",
      dealerName: pickupSite?.name ?? pickupAddress?.name ?? "Pickup place",
      dealerCity: pickupAddress?.city ?? "",
      dealerCountry: pickupAddress?.country ?? "",
      dealerTimezone: pickupSite?.timezone ?? pickupAddress?.timezone ?? null,
      dealerClosingTime: closing.time,
      dealerHoursNote: closing.note,
      deliveryName: deliverySite?.name ?? deliveryAddress?.name ?? "Delivery place",
      deliveryCity: deliveryAddress?.city ?? "",
      deliveryCountry: deliveryAddress?.country ?? "",
      pickupSlot: slot,
      pickupAvailability: windowOf(availabilityRow),
      deliveryPromise: windowOf(promiseRow),
      sources: [{ table: "orders", id: order.id }],
    }
  })
  const ordersById = new Map(orders.map((order) => [order.id, order]))

  const assignments: AssignmentRecord[] = assignmentRows.map((row) => {
    const pos = row.positioning
    return {
      id: row.id,
      orderId: row.order_id,
      orderRef: refOf(row.order_id),
      driverId: row.driver_id,
      status: row.status,
      fee: { cents: row.fee_cents, currency: row.currency },
      positioning: pos
        ? {
            plannedReleaseCity: pos.planned_release_city ?? null,
            plannedReleaseCountry: pos.planned_release_country ?? null,
            earliestAvailableAt: pos.driver_reported_earliest_departure_at ?? pos.earliest_positioning_departure_at ?? null,
            driverReportMessageId: pos.driver_report_message_id ?? null,
          }
        : null,
      sources: [{ table: "work_assignments", id: row.id }],
    }
  })

  const drivers: DriverRecord[] = driverRows.filter((driver) => driver.active !== false).map((driver) => {
    const mine = assignments.filter((row) => row.driverId === driver.id && row.status !== "CANCELLED")
    const active = [...mine.filter((row) => row.status === "IN_PROGRESS"), ...mine.filter((row) => row.status === "ASSIGNED")]
    const current = active[0] ?? null
    const status: DriverStatus = current?.status === "IN_PROGRESS" ? "on_job" : current ? "booked" : "available"
    const statusBasis = !current
      ? "No assigned or in-progress work in this snapshot. That does not prove the driver is free."
      : status === "on_job"
        ? `In progress on ${current.orderRef} at the snapshot`
        : `Booked on ${current.orderRef}, not started at the snapshot`
    const withPosition = active.find((row) => row.positioning) ?? null
    const pos = withPosition?.positioning ?? null
    const currentLocation: Location = pos?.plannedReleaseCity
      ? { city: pos.plannedReleaseCity, country: pos.plannedReleaseCountry ?? driver.home_country, basis: "PLANNED_RELEASE_CITY", confirmed: false, note: "Planned end of current job, not a live position" }
      : { city: driver.home_city, country: driver.home_country, basis: "HOME_CITY", confirmed: false, note: "Home city, not a confirmed location" }
    const progress = active.find((row) => row.status === "IN_PROGRESS") ?? null
    return {
      id: driver.id,
      name: driver.display_name,
      homeCity: driver.home_city,
      homeCountry: driver.home_country,
      status,
      statusBasis,
      currentLocation,
      earliestAvailableAt: pos?.earliestAvailableAt ?? null,
      progressRef: progress?.orderRef ?? null,
      sources: [{ table: "drivers", id: driver.id }, ...(withPosition ? [{ table: "work_assignments", id: withPosition.id }] : [])],
    }
  })

  const alerts: AlertRecord[] = alertRows.map((row) => {
    const assignment = row.assignment_id ? assignments.find((item) => item.id === row.assignment_id) : undefined
    return {
      id: row.id,
      orderId: row.order_id,
      signal: row.signal,
      label: signalLabel(row.signal),
      severity: row.severity,
      status: row.status,
      summary: row.summary,
      triggeredAt: row.triggered_at,
      acknowledgedAt: row.acknowledged_at ?? null,
      acknowledgementReason: row.acknowledgement_reason ?? null,
      owner: row.owner ? operatorTitle(row.owner) : null,
      assignmentId: row.assignment_id ?? null,
      driverId: assignment?.driverId ?? null,
      nextAction: row.next_action ?? null,
      sources: [{ table: "alerts", id: row.id }],
    }
  })

  const alertEvents: EventRecord[] = alertRows.flatMap((row) => {
    const raised: EventRecord = {
      orderId: row.order_id,
      timestamp: row.triggered_at,
      kind: "alert",
      eventType: signalLabel(row.signal),
      message: row.summary,
      actor: "Monitoring",
      source: { table: "alerts", id: row.id },
    }
    if (!row.acknowledged_at) return [raised]
    const acknowledged: EventRecord = {
      orderId: row.order_id,
      timestamp: row.acknowledged_at,
      kind: "alert",
      eventType: "Alert acknowledged",
      message: row.acknowledgement_reason ?? "",
      actor: row.owner ? operatorTitle(row.owner) : "Operations",
      source: { table: "alerts", id: row.id },
    }
    return [raised, acknowledged]
  })

  const messageEvents: EventRecord[] = messageRows.flatMap((row) => row.order_id
    ? [{
        orderId: row.order_id,
        timestamp: row.authored_at,
        kind: "message" as const,
        eventType: messageLabel(row),
        message: row.body,
        actor: actorName(row.author_type, row.author_id),
        source: { table: "messages", id: row.id },
      }]
    : [])

  const operationEvents: EventRecord[] = eventRows.flatMap((row) => row.order_id
    ? [{
        orderId: row.order_id,
        timestamp: row.recorded_at,
        kind: "operation" as const,
        eventType: commandLabel(row.command),
        message: operationMessage(row),
        actor: actorName(row.actor_type, row.actor_id),
        source: { table: "operational_events", id: row.id },
      }]
    : [])

  const events = [...alertEvents, ...messageEvents, ...operationEvents]
    .sort((a, b) => ms(a.timestamp) - ms(b.timestamp) || a.source.id.localeCompare(b.source.id))

  const offers: OfferRecord[] = offerRows.map((row) => {
    const order = ordersById.get(row.order_id)
    return {
      id: row.id,
      orderId: row.order_id,
      orderRef: refOf(row.order_id),
      status: row.status,
      type: row.type,
      visibility: row.visibility,
      fee: { cents: row.fee_cents, currency: row.currency },
      publishedAt: row.published_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at ?? null,
      withdrawnAt: row.withdrawn_at ?? null,
      pickupCity: order?.dealerCity || null,
      pickupCountry: order?.dealerCountry || null,
      deliveryCity: order?.deliveryCity || null,
      deliveryCountry: order?.deliveryCountry || null,
      pickupSlot: order?.pickupSlot ?? null,
      sources: [{ table: "market_offers", id: row.id }],
    }
  })

  const proposals: ProposalRecord[] = proposalRows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    alertId: row.alert_id ?? null,
    command: row.command,
    commandLabel: proposalCommandLabel(row.command),
    summary: row.summary,
    rationale: row.rationale ?? "",
    status: row.status,
    statusLabel: proposalStatusLabel(row.status),
    createdAt: row.created_at,
    review: row.review
      ? {
          decision: row.review.decision,
          decisionNote: row.review.decision_note ?? null,
          reviewedAt: row.review.reviewed_at ?? null,
          reviewer: row.review.reviewer_id ? operatorTitle(row.review.reviewer_id) : null,
        }
      : null,
    sources: [{ table: "agent_proposals", id: row.id }],
  }))

  return { snapshotAt, orders, drivers, events, alerts, offers, assignments, proposals }
}

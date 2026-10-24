import "server-only"

import { and, asc, desc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { addresses, customers, drivers, messages, orderItems, orders, relatedRecords, sites, vehicles } from "@/lib/schema"
import type { OpeningHours } from "@/lib/watch/hours"
import { cwBookings, cwMessages, cwWatches, type EvidenceRef } from "@/lib/watch/schema"
import { formatLocal } from "@/lib/watch/slack"

// Reads the facts an agent tool needs, each with the record it came from.
// Snapshot records are the dataset; cw_* records are what happened in this demo.

export type Sourced<T> = T & { source: string }
export const ref = (table: string, id: string): EvidenceRef => ({ table, id })
export const src = (table: string, id: string) => `${table}:${id}`

async function related(collection: string, orderId: string) {
  return db.select().from(relatedRecords).where(and(eq(relatedRecords.collection, collection), eq(relatedRecords.orderId, orderId)))
}

export async function watchForOrder(orderId: string) {
  const [watch] = await db.select().from(cwWatches).where(eq(cwWatches.orderId, orderId))
  return watch ?? null
}

export async function orderContext(orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
  if (!order) throw new Error(`Order ${orderId} not found`)
  const [customer] = await db.select().from(customers).where(eq(customers.id, order.customerId))
  const [delivery] = await db.select().from(addresses).where(eq(addresses.id, order.deliveryAddressId))
  const [pickup] = await db.select().from(addresses).where(eq(addresses.id, order.pickupAddressId))
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
  const cars = items.length ? await db.select().from(vehicles).where(eq(vehicles.id, items[0].vehicleId)) : []
  const [site] = order.deliverySiteId ? await db.select().from(sites).where(eq(sites.id, order.deliverySiteId)) : []
  const siteDetails = (site?.details ?? {}) as { opening_hours?: OpeningHours | null; timezone?: string; advance_notice_minutes?: number; delivery_access_note?: string }
  const watch = await watchForOrder(orderId)
  const [driver] = watch?.driverId ? await db.select().from(drivers).where(eq(drivers.id, watch.driverId)) : []
  const windows = await related("time_windows", orderId)
  const promise = windows.map((w) => w.details as Record<string, string | boolean>)
    .find((w) => w.purpose === "CUSTOMER_DELIVERY_PROMISE" && w.is_selected)
  const snapshotMessages = await db.select().from(messages).where(eq(messages.orderId, orderId)).orderBy(desc(messages.authoredAt)).limit(6)
  const demoMessages = await db.select().from(cwMessages).where(eq(cwMessages.orderId, orderId)).orderBy(desc(cwMessages.at)).limit(8)

  return {
    order: { reference: order.reference, status: order.status, routeKind: order.routeKind, source: src("orders", order.id) },
    car: cars[0] ? { name: `${cars[0].make} ${cars[0].model} (${cars[0].modelYear})`, source: src("vehicles", cars[0].id) } : null,
    customer: customer ? { name: customer.name, rule: "Customer: the agent never contacts them. Customer messages are drafts a person sends.", source: src("customers", customer.id) } : null,
    driver: driver ? { name: driver.displayName, rule: "Driver: the agent may message them.", source: src("drivers", driver.id) } : null,
    route: { from: pickup?.city ?? null, to: delivery?.city ?? null, source: src("addresses", order.deliveryAddressId) },
    receivingSite: site ? {
      name: site.name, hours: siteDetails.opening_hours ?? null, timezone: siteDetails.timezone ?? "UTC",
      callAheadMin: siteDetails.advance_notice_minutes ?? 0, deliveryNote: siteDetails.delivery_access_note ?? null,
      rule: "Belongs to the customer: do not contact. Messages to them are drafts a person sends.", source: src("sites", site.id),
    } : null,
    deliveryPromise: promise
      ? {
        window: `${formatLocal(new Date(String(promise.start_at)), String(promise.timezone))}–${formatLocal(new Date(String(promise.end_at)), String(promise.timezone))} local on ${String(promise.start_at).slice(0, 10)}`,
        startAt: promise.start_at, endAt: promise.end_at, setBy: promise.source, source: src("time_windows", String(promise.id)),
      }
      : null,
    recentMessages: [
      ...snapshotMessages.reverse().map((m) => ({
        at: m.authoredAt.toISOString(), from: m.authorType, channel: (m.details as Record<string, unknown>).channel ?? null,
        body: m.body, source: src("messages", m.id),
      })),
      ...demoMessages.reverse().map((m) => ({ at: m.at.toISOString(), from: m.party === "agent" ? `agent → ${m.direction === "out" ? "driver" : "?"}` : m.party, channel: "driver_app", body: m.body, source: src("cw_messages", String(m.id)) })),
    ],
  }
}

export async function travelContext(orderId: string) {
  const reservations = await related("travel_reservations", orderId)
  const options = await related("travel_options", orderId)
  const bookings = await db.select().from(cwBookings).where(eq(cwBookings.orderId, orderId)).orderBy(asc(cwBookings.createdAt))
  return {
    booked: reservations.map((r) => {
      const d = r.details as Record<string, unknown>
      const amendment = d.amendment_request as Record<string, unknown> | undefined
      return {
        label: d.status === "BOOKED" ? "BOOKED" : String(d.status), kind: d.kind, reference: d.booking_reference ?? null,
        route: d.route_label ?? null, checkInCutoffAt: d.check_in_cutoff_at ?? null, departureAt: d.departure_at ?? null,
        from: d.origin_terminal ?? d.from_city ?? null, to: d.destination_terminal ?? d.to_city ?? null,
        checkIn: d.check_in_confirmation ?? null, boarding: d.boarding_confirmation ?? null,
        amendment: amendment ? { status: amendment.status, requested: amendment.requested_change, note: "Requested from the carrier, not confirmed: not a booking." } : null,
        source: src("travel_reservations", r.id),
      }
    }),
    quotedOnly: options.map((o) => {
      const d = o.details as Record<string, unknown>
      return { label: "QUOTE, NOT BOOKED", status: d.status, kind: d.kind, provider: d.provider, departureAt: d.departure_at, checkInCutoffAt: d.check_in_cutoff_at, capacity: d.capacity_note, quoteCents: d.quote_cents, source: src("travel_options", o.id) }
    }),
    madeInThisDemo: bookings.map((b) => ({ label: "MOCK BOOKING (approved by a person)", kind: b.kind, what: b.label, reference: b.reference, costCents: b.costCents, source: src("cw_bookings", b.id) })),
  }
}

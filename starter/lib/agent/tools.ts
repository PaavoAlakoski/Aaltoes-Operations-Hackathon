import "server-only"

import { and, desc, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { db } from "@/lib/db"
import { emit } from "@/lib/watch/bus"
import { DEFAULT_ONWARD_DRIVE_MIN, HOTELS, ONWARD_DRIVE_MIN, SAILINGS, type Sailing } from "@/lib/watch/mock/world"
import { cwMessages, cwPositions, cwProposals, type EvidenceRef, type ProposalChange } from "@/lib/watch/schema"
import { handoverOutlook } from "@/lib/watch/hours"
import { formatLocal, THRESHOLDS } from "@/lib/watch/slack"
import { orderContext, ref, travelContext, watchForOrder } from "./context"
import { defineTool, type AgentTool, type ToolContext, type ToolOutcome } from "./types"

// The agent's tools, cheapest first. None of them changes a booking, a date or a cost, and none
// reaches a customer: those only exist as change kinds inside propose_action, carried out by the
// executor after a person approves.

const MOVING_KMH = 5
const BOOKING_LEAD_MIN = 15
const MAX_WAIT_MIN = 120
const MIN_WAIT_MIN = 5

export type ToolHooks = { onDriverMessage: (orderId: string, body: string, quickReplies: string[], at: Date) => void }

const usedSlots = (globalThis as unknown as { __cwSlots?: Map<string, number> }).__cwSlots ??= new Map()
export function slotsLeft(s: Sailing) { return s.vehicleSlotsLeft - (usedSlots.get(s.id) ?? 0) }
export function useSlot(id: string) { usedSlots.set(id, (usedSlots.get(id) ?? 0) + 1) }
export function resetSlots() { usedSlots.clear() }

const parseRef = (s: string): EvidenceRef | null => {
  const i = s.indexOf(":")
  return i > 0 && i < s.length - 1 ? { table: s.slice(0, i), id: s.slice(i + 1) } : null
}

async function requireWatch(ctx: ToolContext) {
  const watch = await watchForOrder(ctx.run.orderId)
  if (!watch) throw new Error("This order has no active connection watch")
  return watch
}

const localIso = (d: Date, tz: string) => `${d.toISOString()} (${formatLocal(d, tz)} local)`

const getWatchStatus = defineTool({
  name: "get_watch_status",
  description: "Current state of the connection watch for this order: margin to the deadline, arrival range, how the number was built, and how fresh the GPS is. Cheap; call it first and again after waiting.",
  schema: z.strictObject({}),
  async run(_input, ctx) {
    const w = await requireWatch(ctx)
    const minutesSincePosition = w.lastPositionAt ? Math.round((ctx.now.getTime() - w.lastPositionAt.getTime()) / 60000) : null
    const result = {
      state: w.state,
      marginMin: w.slackMin,
      target: w.targetLabel,
      deadline: `${w.targetKind === "FERRY_CHECKIN" ? "Check-in closes" : "Deadline"} ${localIso(w.deadlineAt, w.targetTimezone)}`,
      departure: w.departureAt ? localIso(w.departureAt, w.targetTimezone) : null,
      arrivalRange: w.etaLowAt && w.etaHighAt ? `${formatLocal(w.etaLowAt, w.targetTimezone)}–${formatLocal(w.etaHighAt, w.targetTimezone)} local` : null,
      remainingKm: w.remainingKm === null ? null : Math.round(w.remainingKm),
      minutesSinceLastPosition: minutesSincePosition,
      positionIsStale: minutesSincePosition === null || minutesSincePosition > THRESHOLDS.staleAfterMin,
      driverReportedDelayMin: w.reportedDelayMin,
      receivingSite: w.handover ? {
        name: w.handover.siteName,
        rule: "The receiving dealer is the customer: never contact them. A message to them is a DRAFT_CUSTOMER_MESSAGE.",
        openingHours: w.handover.hours && Object.keys(w.handover.hours).length ? w.handover.hours : "not recorded",
        onArrival: w.outlook ?? null,
        callAheadMin: w.handover.callAheadMin || null,
        accessNote: w.handover.accessNote,
        promisedWindow: w.handover.promiseStartAt && w.handover.promiseEndAt
          ? `${formatLocal(new Date(w.handover.promiseStartAt), w.targetTimezone)}–${formatLocal(new Date(w.handover.promiseEndAt), w.targetTimezone)} local`
          : null,
        promiseBroken: Boolean(w.handover.promiseBrokenAt),
        sources: [`sites:${w.handover.siteId}`, ...(w.handover.promiseRef ? [`${w.handover.promiseRef.table}:${w.handover.promiseRef.id}`] : [])],
      } : null,
      howTheNumberIsBuilt: w.explanation,
      sources: [`cw_watches:${w.id}`, `${w.targetRef.table}:${w.targetRef.id}`, ...(w.planningRef ? [`${w.planningRef.table}:${w.planningRef.id}`] : [])],
      note: "GPS and route are demo data from the driver app replay. The planning range is a historical estimate, not a live ETA.",
    }
    return { result, summary: `Checked the watch: ${w.state.toLowerCase().replace("_", " ")}, margin ${w.slackMin ?? "unknown"} min`, evidenceRefs: [ref("cw_watches", w.id), w.targetRef] }
  },
})

const getOrderContext = defineTool({
  name: "get_order_context",
  description: "The order, car, customer (never contact them), driver, route, delivery promise and the latest messages, each with its source record.",
  schema: z.strictObject({}),
  async run(_input, ctx) {
    const result = await orderContext(ctx.run.orderId)
    return { result, summary: `Read the order ${result.order.reference}, the delivery promise and ${result.recentMessages.length} recent messages`, evidenceRefs: [ref("orders", ctx.run.orderId)] }
  },
})

const getTravel = defineTool({
  name: "get_travel",
  description: "Travel for this order, split into BOOKED, QUOTE NOT BOOKED, and mock bookings a person approved in this demo. A quote or an amendment request is never a booking.",
  schema: z.strictObject({}),
  async run(_input, ctx) {
    const result = await travelContext(ctx.run.orderId)
    return { result, summary: `Read the travel: ${result.booked.length} booked, ${result.quotedOnly.length} quoted only`, evidenceRefs: result.booked.map((b) => ({ table: "travel_reservations", id: b.source.split(":")[1] })) }
  },
})

const searchSailings = defineTool({
  name: "search_sailings",
  description: "Later crossings from the same terminal, from the mock carrier: departure, check-in cutoff, vehicle slots left, fare difference, when sales close, whether this car can reach that check-in, the delivery time it would give against the promise, and the latest time a person must approve so the booking can still be made. Quotes only, nothing is held.",
  schema: z.strictObject({}),
  async run(_input, ctx) {
    const w = await requireWatch(ctx)
    if (w.targetKind !== "FERRY_CHECKIN") return { result: "This order is not waiting for a ferry; there are no sailings to search.", isError: true, summary: "No ferry on this case" }
    const travel = await travelContext(ctx.run.orderId)
    const order = await orderContext(ctx.run.orderId)
    const fromTerminal = terminalFromTravel(travel)
    const promiseEnd = order.deliveryPromise ? new Date(String(order.deliveryPromise.endAt)) : null
    const promiseStart = order.deliveryPromise ? new Date(String(order.deliveryPromise.startAt)) : null
    const arrivalHigh = w.etaHighAt ? new Date(w.etaHighAt.getTime() + 20 * 60000) : null
    const destCity = order.route.to ?? ""
    const sailings = SAILINGS
      .filter((s) => (fromTerminal ? s.fromTerminalId === fromTerminal : true) && new Date(s.departureAt) > (w.departureAt ?? ctx.now))
      .map((s) => {
        const cutoff = new Date(s.checkInCutoffAt)
        const salesClose = new Date(s.salesCloseAt)
        const decideBy = new Date(salesClose.getTime() - BOOKING_LEAD_MIN * 60000)
        const onward = ONWARD_DRIVE_MIN[s.toTerminalId]?.[destCity] ?? DEFAULT_ONWARD_DRIVE_MIN
        const delivery = new Date(new Date(s.arrivalAt).getTime() + onward * 60000)
        const promise = !promiseEnd || !promiseStart ? "no promise on record"
          : delivery <= promiseEnd ? (delivery < promiseStart ? "meets the promise: the car is there before the window opens" : "meets the promise: delivers inside the window")
            : `breaks the promise: about ${Math.round((delivery.getTime() - promiseEnd.getTime()) / 3600000)} h after the window closes, so the customer must agree`
        return {
          sailingId: s.id, provider: s.provider, label: "MOCK CARRIER QUOTE, NOT BOOKED",
          departure: localIso(new Date(s.departureAt), w.targetTimezone), checkInCloses: localIso(cutoff, w.targetTimezone),
          vehicleSlotsLeft: slotsLeft(s), fareDifferenceEur: s.fareDeltaCents / 100,
          canReachCheckIn: arrivalHigh ? arrivalHigh < cutoff : null,
          estimatedDelivery: `${delivery.toISOString()} (${destCity || "destination"}, ${onward} min drive from the arrival terminal)`,
          deliveryPromise: promise,
          receivingSite: order.receivingSite
            ? handoverOutlook({ siteName: order.receivingSite.name, hours: order.receivingSite.hours, timezone: order.receivingSite.timezone, arriveLow: delivery, arriveHigh: delivery }).lines[0]
            : "private address: no opening hours",
          salesClose: localIso(salesClose, w.targetTimezone),
          decideBy: decideBy > ctx.now ? localIso(decideBy, w.targetTimezone) : "too late: sales have closed or close within the booking lead time",
          decideByIso: decideBy.toISOString(),
          source: `mock_sailings:${s.id}`,
        }
      })
    return { result: { sailings, note: "Mock carrier timetable and capacity for the demo. Fares are differences to the current booking." }, summary: `Looked up ${sailings.length} later sailings`, evidenceRefs: sailings.map((s) => ({ table: "mock_sailings", id: s.sailingId })) }
  },
})

function terminalFromTravel(travel: Awaited<ReturnType<typeof travelContext>>): string | null {
  const ferry = travel.booked.find((b) => b.kind === "FERRY")
  if (!ferry) return null
  const name = String(ferry.from)
  if (name.includes("West Baltic")) return "terminal-west-baltic"
  if (name.includes("East Nordic")) return "terminal-east-nordic"
  if (name.includes("South Baltic")) return "terminal-south-baltic"
  return null
}

const searchHotels = defineTool({
  name: "search_hotels",
  description: "Mock hotels near the departure terminal with nightly price and walking time. Prices are quotes; nothing is reserved.",
  schema: z.strictObject({}),
  async run(_input, ctx) {
    const travel = await travelContext(ctx.run.orderId)
    const terminal = terminalFromTravel(travel)
    const hotels = HOTELS.filter((h) => h.nearTerminalId === terminal).map((h) => ({
      hotelId: h.id, name: h.name, nightlyEur: h.nightlyCents / 100, walkMinToTerminal: h.walkMinToTerminal, label: "MOCK QUOTE", source: `mock_hotels:${h.id}`,
    }))
    return { result: { hotels }, summary: `Looked up ${hotels.length} hotels near the terminal`, evidenceRefs: hotels.map((h) => ({ table: "mock_hotels", id: h.hotelId })) }
  },
})

export function messageDriverTool(hooks: ToolHooks): AgentTool {
  return defineTool({
    name: "message_driver",
    description: "Send the driver a short message in the driver app. Allowed without approval. While the car is moving, the driver can only tap a quick reply, so give 2–4 short quick_replies; free text questions are only allowed when the car is stopped. Never give mechanical advice. The reply wakes you after wait_for.",
    schema: z.strictObject({ text: z.string(), quick_replies: z.array(z.string()) }),
    async run(input, ctx) {
      const w = await requireWatch(ctx)
      const [last] = await db.select().from(cwPositions).where(eq(cwPositions.assignmentId, w.assignmentId)).orderBy(desc(cwPositions.observedAt)).limit(1)
      const moving = (last?.speedKmh ?? 0) > MOVING_KMH
      if (input.text.length > 280) return { result: "Too long for a driver at the wheel. Keep it under 280 characters.", isError: true, summary: "Message to the driver was too long" }
      if (moving && (input.quick_replies.length < 2 || input.quick_replies.length > 4)) {
        return { result: `The car is moving at about ${Math.round(last!.speedKmh!)} km/h. Offer 2–4 quick_replies the driver can tap safely.`, isError: true, summary: "Held a message: the driver is driving" }
      }
      const [row] = await db.insert(cwMessages).values({ orderId: ctx.run.orderId, runId: ctx.run.id, party: "agent", direction: "out", body: input.text, quickReplies: input.quick_replies, at: ctx.now }).returning()
      emit({ type: "message", orderId: ctx.run.orderId, party: "agent", direction: "out", body: input.text, quickReplies: input.quick_replies, at: ctx.now.toISOString() })
      hooks.onDriverMessage(ctx.run.orderId, input.text, input.quick_replies, ctx.now)
      return { result: "Sent to the driver app. Call wait_for to be woken by the reply.", summary: `Asked the driver: "${input.text}"`, evidenceRefs: [ref("cw_messages", String(row.id))] }
    },
  })
}

const askCarrier = defineTool({
  name: "ask_carrier",
  description: "Ask the carrier desk (mock) about this booking: whether late check-in after the cutoff is possible, current space on later sailings, or the status of an amendment request. Allowed without approval; it changes nothing.",
  schema: z.strictObject({ topic: z.enum(["late_check_in", "later_sailing_space", "amendment_status"]), booking_reference: z.string() }),
  async run(input, ctx) {
    const w = await requireWatch(ctx)
    const travel = await travelContext(ctx.run.orderId)
    const booked = travel.booked.find((b) => b.reference === input.booking_reference)
    if (!booked) return { result: `The carrier has no booking ${input.booking_reference} for this order.`, isError: true, summary: "Carrier did not find the booking" }
    let answer: string
    if (input.topic === "late_check_in") answer = "Vehicle deck check-in closes at the cutoff. Cars arriving later are not accepted on this sailing; the booking can be moved to a later sailing if space is available."
    else if (input.topic === "amendment_status") answer = booked.amendment ? `The request to move to a later crossing is recorded but not confirmed (${booked.amendment.status}). No slot or fare is held.` : "No amendment request on this booking."
    else {
      const terminal = terminalFromTravel(travel)
      answer = SAILINGS.filter((s) => s.fromTerminalId === terminal && new Date(s.departureAt) > (w.departureAt ?? ctx.now))
        .map((s) => `${formatLocal(new Date(s.departureAt), w.targetTimezone)} on ${s.departureAt.slice(0, 10)}: ${slotsLeft(s)} vehicle slots`).join("; ") || "No later sailings listed."
    }
    return { result: { carrier: "Mock carrier desk", answer, source: `mock_carrier:${input.booking_reference}:${input.topic}` }, summary: `Asked the carrier about ${input.topic.replaceAll("_", " ")}`, evidenceRefs: [{ table: "mock_carrier", id: `${input.booking_reference}:${input.topic}` }] }
  },
})

const waitFor = defineTool({
  name: "wait_for",
  description: "Pause until something new happens: a driver reply, a change in the watch, an operator message or decision, or the given number of minutes. Use it after asking someone, or when the situation may resolve by itself.",
  schema: z.strictObject({ reason: z.string(), minutes: z.number() }),
  async run(input, ctx): Promise<ToolOutcome> {
    const minutes = Math.min(MAX_WAIT_MIN, Math.max(MIN_WAIT_MIN, Math.round(input.minutes)))
    return { result: "paused", summary: `Waiting up to ${minutes} min: ${input.reason}`, suspend: { status: "waiting", waitUntil: new Date(ctx.now.getTime() + minutes * 60000), reason: input.reason } }
  },
})

const CHANGE_KINDS = ["REBOOK_FERRY", "BOOK_HOTEL", "APPROVE_EXPENSE", "DRAFT_CUSTOMER_MESSAGE", "KEEP_CURRENT_BOOKING", "TASK_FOR_PERSON"] as const
const NO_APPROVAL: string[] = ["KEEP_CURRENT_BOOKING", "TASK_FOR_PERSON"]

const proposeAction = defineTool({
  name: "propose_action",
  description: "Bring a person one decision. Use it when a change needs approval (a booking, a cost, a date, any message to the customer), when the customer promise is at risk, or when facts conflict. Changes: REBOOK_FERRY (sailing_id from search_sailings), BOOK_HOTEL (hotel_id from search_hotels), APPROVE_EXPENSE (cost_cents), DRAFT_CUSTOMER_MESSAGE (draft_body: a person reviews and sends it), KEEP_CURRENT_BOOKING, TASK_FOR_PERSON (something only a person can do, e.g. call the dealer). Costs and the decide-by time are taken from the quotes, not from you. Nothing happens until a person approves; you are woken with their decision.",
  schema: z.strictObject({
    title: z.string(),
    reason: z.string(),
    changes: z.array(z.strictObject({
      kind: z.enum(CHANGE_KINDS),
      label: z.string(),
      sailing_id: z.string().nullable(),
      hotel_id: z.string().nullable(),
      cost_cents: z.number().nullable(),
      draft_body: z.string().nullable(),
    })),
    after_approval: z.string(),
    evidence: z.array(z.string()),
  }),
  async run(input, ctx): Promise<ToolOutcome> {
    const problems: string[] = []
    if (input.changes.length === 0) problems.push("Give at least one change.")
    const evidence = input.evidence.map(parseRef)
    if (evidence.length === 0 || evidence.some((e) => !e)) problems.push("evidence must list the sources you relied on as table:id, e.g. travel_reservations:res-x…")
    let decideBy: Date | null = null
    const changes: ProposalChange[] = input.changes.map((c) => {
      let costCents = c.kind === "APPROVE_EXPENSE" ? c.cost_cents : null
      if (c.kind === "REBOOK_FERRY") {
        const s = SAILINGS.find((x) => x.id === c.sailing_id)
        if (!s) problems.push(`Unknown sailing_id ${c.sailing_id}; use one from search_sailings.`)
        else {
          if (slotsLeft(s) <= 0) problems.push(`Sailing ${s.id} has no vehicle slots left.`)
          costCents = s.fareDeltaCents
          const d = new Date(new Date(s.salesCloseAt).getTime() - BOOKING_LEAD_MIN * 60000)
          decideBy = !decideBy || d < decideBy ? d : decideBy
        }
      }
      if (c.kind === "BOOK_HOTEL") {
        const h = HOTELS.find((x) => x.id === c.hotel_id)
        if (!h) problems.push(`Unknown hotel_id ${c.hotel_id}; use one from search_hotels.`)
        else costCents = h.nightlyCents
      }
      if (c.kind === "DRAFT_CUSTOMER_MESSAGE" && !c.draft_body?.trim()) problems.push("DRAFT_CUSTOMER_MESSAGE needs draft_body.")
      if (c.kind === "APPROVE_EXPENSE" && (!c.cost_cents || c.cost_cents <= 0)) problems.push("APPROVE_EXPENSE needs a positive cost_cents.")
      return { kind: c.kind, label: c.label, sailingId: c.sailing_id, hotelId: c.hotel_id, costCents, draftBody: c.draft_body, needsApproval: !NO_APPROVAL.includes(c.kind) }
    })
    if (problems.length) return { result: { notCreated: true, problems }, isError: true, summary: "Proposal not created: needs fixing" }

    // A new proposal replaces any earlier one still waiting on this order; history is kept.
    const id = `prop-${ctx.run.id.slice(4, 10)}-${Date.now().toString(36)}`
    const open = await db.select().from(cwProposals).where(and(eq(cwProposals.orderId, ctx.run.orderId), inArray(cwProposals.status, ["pending", "changed"])))
    for (const p of open) await db.update(cwProposals).set({ status: "superseded", supersededBy: id }).where(eq(cwProposals.id, p.id))
    await db.insert(cwProposals).values({
      id, runId: ctx.run.id, orderId: ctx.run.orderId, title: input.title, reason: input.reason, changes,
      decideByAt: decideBy, afterApproval: input.after_approval, evidenceRefs: evidence as EvidenceRef[], status: "pending", createdAt: ctx.now,
    })
    emit({ type: "agent", orderId: ctx.run.orderId, runId: ctx.run.id, what: "proposal", status: "pending", at: ctx.now.toISOString() })
    return {
      result: { proposalId: id }, summary: `Proposed: ${input.title}`, evidenceRefs: evidence as EvidenceRef[],
      suspend: { status: "awaiting_decision", reason: input.title },
    }
  },
})

const closeRun = defineTool({
  name: "close_run",
  description: "Close the case without bothering anyone: the margin recovered, the signal is explained, or the connection was made. Say in one or two plain sentences why, and list the sources.",
  schema: z.strictObject({ summary: z.string(), evidence: z.array(z.string()) }),
  async run(input): Promise<ToolOutcome> {
    const evidence = input.evidence.map(parseRef)
    if (evidence.length === 0 || evidence.some((e) => !e)) return { result: "List the sources you relied on as table:id.", isError: true, summary: "Close needs sources" }
    return { result: "closed", summary: `Closed: ${input.summary}`, evidenceRefs: evidence as EvidenceRef[], suspend: { status: "closed", reason: input.summary } }
  },
})

export function agentTools(hooks: ToolHooks): AgentTool[] {
  return [getWatchStatus, getOrderContext, getTravel, searchSailings, searchHotels, messageDriverTool(hooks), askCarrier, waitFor, proposeAction, closeRun]
}

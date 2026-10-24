import "server-only"
import { DEFAULT_MAX_KM, findNewOrderForStrandedDriver, findStandbyDriver, getRecoveryCase } from "../agent-tools"
import { fmtDateTime, fmtMoney, fmtRange } from "../present/time"
import { loadDataset } from "./dataset"
import { RECOVERY_SIGNALS } from "./labels"
import type { EventRecord, KeyEvent, MoveNode, Option, RecoveryPlan, RecoverySignal } from "./types"

const ms = (value: string) => Date.parse(value)

/** The ImpactTree for one open recovery. Built only by calling the agent tools and reading their output. */
export async function buildRecoveryPlan(orderId: string): Promise<RecoveryPlan | null> {
  const detail = await getRecoveryCase({ orderId })
  if (!detail?.alert || !detail.assignment || !detail.driver) return null
  if (!RECOVERY_SIGNALS.includes(detail.alert.signal as RecoverySignal)) return null

  const { order, alert, assignment, driver, events, proposals } = detail
  const signal = alert.signal as RecoverySignal
  const { snapshotAt } = await loadDataset()
  const tz = order.pickupSlot?.timezone ?? order.dealerTimezone ?? "UTC"
  const at = (value: string) => fmtDateTime(value, tz)
  const from = driver.currentLocation.city

  const standby = await findStandbyDriver({ orderId: order.id, maxKm: DEFAULT_MAX_KM, limit: 3 })
  const offers = signal === "POSITIONING_AT_RISK"
    ? await findNewOrderForStrandedDriver({ driverId: driver.id, maxKm: DEFAULT_MAX_KM, limit: 3 })
    : null

  const standbyOptions: Option[] = (standby?.candidates ?? []).map((candidate) => ({
    id: candidate.driverId,
    label: candidate.name,
    detail: `${candidate.distanceKm} km from ${candidate.location.city} · ${candidate.location.basis === "HOME_CITY" ? "home city, not a confirmed location" : "planned release city"} · not asked yet`,
    sources: candidate.sources,
  }))

  // Messages and alerts for the root node. The driver's message nearest the alert is the one that raised it.
  const driverMessages = events.filter((row) => row.kind === "message" && row.eventType === "Driver message")
  const trigger = ms(alert.triggeredAt)
  const quoteRow = [...driverMessages].reverse().find((row) => ms(row.timestamp) <= trigger) ?? driverMessages[0] ?? null
  const latestDriverRow = driverMessages[driverMessages.length - 1] ?? null
  const raisedRow = events.find((row) => row.source.id === alert.id && row.eventType !== "Alert acknowledged") ?? null
  const ackRow = events.find((row) => row.source.id === alert.id && row.eventType === "Alert acknowledged") ?? null
  const keyEvents: KeyEvent[] = [
    quoteRow ? toKey(quoteRow, quoteRow.eventType) : null,
    raisedRow ? toKey(raisedRow, "Alert") : null,
    ackRow ? toKey(ackRow, "Alert acknowledged") : null,
  ].filter((item): item is KeyEvent => item !== null).sort((a, b) => ms(a.at) - ms(b.at))

  const priorWork = proposals.map((proposal) => ({
    summary: proposal.summary,
    statusLabel: proposal.statusLabel,
    decisionNote: proposal.review?.decisionNote ?? null,
    source: proposal.sources[0],
  }))

  const assignmentSource = assignment.sources[0]
  const alertSource = alert.sources[0]
  const earliest = driver.earliestAvailableAt

  let headline: string
  let summary: string
  const carBranch: MoveNode[] = []
  const driverBranch: MoveNode[] = []

  if (signal === "POSITIONING_AT_RISK") {
    headline = "The driver can't reach the pickup slot"
    summary = `${driver.name} is finishing ${driver.progressRef ?? "a job"} in ${from} and reports they cannot reach ${order.dealerCity} for the selected slot. ${earliest ? `Their reported earliest departure is ${at(earliest)}. ` : ""}The slot starts ${order.pickupSlot ? at(order.pickupSlot.start) : "at a time not recorded"}.`

    const carOffer: MoveNode = {
      id: "car-offer",
      lane: "car",
      kind: standbyOptions.length > 0 ? "offer" : "empty",
      title: "Offer the pickup to a standby driver",
      body: standbyOptions.length > 0
        ? `Available drivers with a home city within ${DEFAULT_MAX_KM} km of ${order.dealerCity}, nearest first. Nothing is sent until you approve one.`
        : `No available driver has a home city within ${DEFAULT_MAX_KM} km of ${order.dealerCity} in this snapshot.`,
      options: standbyOptions,
      actionLabel: "Approve offer",
      note: null,
      dependsOn: [],
      lockedText: null,
      log: "Directed offer sent (simulated)",
      doneNote: `${driver.name} stays booked until the new driver accepts.`,
      quote: null,
      sources: standby?.sources ?? order.sources,
    }
    const carCustomer: MoveNode = {
      id: "car-customer",
      lane: "car",
      kind: "person",
      title: `Call ${order.customerName} to agree the driver change`,
      body: "The alert's next step says buyer approval is needed before the slot or the assignment changes. The app does not contact the customer.",
      options: [],
      actionLabel: "Mark as done",
      note: "Only a person can do this",
      dependsOn: [],
      lockedText: null,
      log: "Customer call marked done",
      doneNote: "Recorded by an operator. The app sent nothing.",
      quote: null,
      sources: [alertSource],
    }
    const carRelease: MoveNode = {
      id: "car-release",
      lane: "car",
      kind: "release",
      title: `Release ${driver.name} from this pickup`,
      body: "Takes the driver off the booking once a replacement has accepted.",
      options: [],
      actionLabel: "Approve release",
      note: null,
      dependsOn: ["car-offer", "car-customer"],
      lockedText: "Locked until the pickup is offered and the customer has agreed the change.",
      log: "Release approved (simulated)",
      doneNote: `${driver.name} is released from this pickup. Simulated only.`,
      quote: null,
      sources: [assignmentSource],
    }
    carBranch.push(carOffer, carCustomer, carRelease)

    const offerOptions: Option[] = (offers?.offers ?? []).map((offer) => ({
      id: offer.offerId,
      label: `${offer.orderRef} · ${offer.route}`,
      detail: `${offer.pickupSlot ? `Slot ${fmtRange(offer.pickupSlot.start, offer.pickupSlot.end, offer.pickupSlot.timezone)}` : "No slot recorded"} · fee ${fmtMoney(offer.fee.cents, offer.fee.currency)} · expires ${fmtDateTime(offer.expiresAt, tz)} · ${offer.distanceKm} km from ${from}`,
      sources: offer.sources,
    }))
    const hasOffers = offerOptions.length > 0
    driverBranch.push({
      id: "driver-offer",
      lane: "driver",
      kind: hasOffers ? "offer" : "empty",
      title: hasOffers ? `Offer ${driver.name} an open job` : `No open job within ${DEFAULT_MAX_KM} km after the driver is free`,
      body: hasOffers
        ? `Published offers with a pickup within ${DEFAULT_MAX_KM} km of ${from}, the planned end of the current job${earliest ? `, with a slot after ${at(earliest)}` : ""}.`
        : `Checked published offers with a pickup near ${from} and a slot after the driver is free. None fits in this snapshot.`,
      options: offerOptions,
      actionLabel: "Approve offer",
      note: null,
      dependsOn: [],
      lockedText: null,
      log: "Directed offer sent (simulated)",
      doneNote: "A published offer is not a booking. The driver still has to accept.",
      quote: null,
      sources: offers?.offers[0]?.sources ?? [],
    })
    if (!hasOffers) {
      driverBranch.push({
        id: "driver-home",
        lane: "driver",
        kind: "person",
        title: "Plan the driver's trip home",
        body: "No open job fits, so a person decides how the driver gets back.",
        options: [],
        actionLabel: "Mark as done",
        note: "Only a person can do this",
        dependsOn: [],
        lockedText: null,
        log: "Trip home planned",
        doneNote: "Recorded by an operator. The app booked nothing.",
        quote: null,
        sources: [],
      })
    }
  } else {
    headline = "The driver may be too unwell to collect"
    summary = `${driver.name} told us they may not be fit to collect ${order.reference} at the booked slot. The driver has not cancelled, and the job stays assigned. The alert comes from that message and is not a confirmed outcome.`

    carBranch.push({
      id: "car-offer",
      lane: "car",
      kind: standbyOptions.length > 0 ? "offer" : "empty",
      title: "Prepare a named backup without cancelling the driver",
      body: standbyOptions.length > 0
        ? `Available drivers with a home city within ${DEFAULT_MAX_KM} km of ${order.dealerCity}, nearest first. The backup is only a plan until a person approves it and the driver accepts.`
        : `No available driver has a home city within ${DEFAULT_MAX_KM} km of ${order.dealerCity} in this snapshot.`,
      options: standbyOptions,
      actionLabel: "Approve offer",
      note: null,
      dependsOn: [],
      lockedText: null,
      log: "Backup offer sent (simulated)",
      doneNote: `${driver.name} stays assigned. The backup is not booked.`,
      quote: null,
      sources: standby?.sources ?? order.sources,
    })
    const latest = latestDriverRow
    driverBranch.push({
      id: "driver-explain",
      lane: "driver",
      kind: "explain",
      title: "No new job offered: the driver reported being unwell",
      body: `${driver.name}'s booked job stays active while a backup is prepared. The alert comes from the driver's message, not a verified outcome.`,
      options: [],
      actionLabel: null,
      note: null,
      dependsOn: [],
      lockedText: null,
      log: "",
      doneNote: "",
      quote: latest ? { text: latest.message, at: latest.timestamp, recordType: latest.eventType, who: latest.actor, source: latest.source } : null,
      sources: [alertSource],
    })
  }

  const availability = order.pickupAvailability
  const alternative = availability && order.pickupSlot && ms(availability.end) > ms(order.pickupSlot.end)
    ? { text: `Or keep ${driver.name}: the customer's window runs until ${fmtDateTime(availability.end, availability.timezone)}. This needs the customer's OK.`, source: availability.source }
    : null

  return {
    snapshotAt,
    orderId: order.id,
    reference: order.reference,
    signal,
    car: { make: order.carMake, model: order.carModel },
    customerName: order.customerName,
    pickup: {
      name: order.dealerName,
      city: order.dealerCity,
      country: order.dealerCountry,
      timezone: order.dealerTimezone,
      closingTime: order.dealerClosingTime,
      hoursNote: order.dealerHoursNote,
    },
    slot: order.pickupSlot,
    availability,
    driver: { id: driver.id, name: driver.name, homeCity: driver.homeCity, location: driver.currentLocation, earliestAvailableAt: earliest },
    root: { headline, summary, keyEvents, priorWork },
    carBranch,
    driverBranch,
    alternative,
    caveats: [
      "Driver locations are the planned end of the current job or the home city, not live positions.",
      "Distances are straight-line between city centres, not road distances.",
      "Nothing here is sent. Approvals are simulated on this screen.",
    ],
  }
}

function toKey(row: EventRecord, recordType: string): KeyEvent {
  return { at: row.timestamp, recordType, who: row.actor, text: row.message, source: row.source }
}

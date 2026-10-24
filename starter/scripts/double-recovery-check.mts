// Runs the double-recovery tools on the dataset without a model and checks the proposal guard.
//   npx tsx --conditions=react-server scripts/double-recovery-check.mts
import assert from "node:assert/strict"
const t = await import("../lib/agent-tools")

const telemetry = await t.checkTelemetry({ orderId: "ord-00992" })
const policy = await t.checkDealerPolicy({ orderId: "ord-00992" })
const truth = await t.assessDriverInTime("ord-00992")
console.log("TELEMETRY", JSON.stringify(telemetry?.math, null, 1), telemetry?.readyAtDealer, telemetry?.pickupSlot)
console.log("POLICY", policy?.closeTime, policy?.keyHandoverMethod, policy?.evidence)
console.log("IN TIME?", truth)
assert.equal(truth?.driverInTime, false)

const standby = await t.findStandbyDriver({ orderId: "ord-00992", limit: 3 })
console.log("STANDBY", standby?.candidates.map((c) => `${c.name} ${c.distanceKm} km from ${c.location.city}`))
const hj = await t.findHotelAndNextJob({ driverId: "drv-260", nearCity: "Frankfurt" })
console.log("HOTELS", hj?.hotels.map((h) => h.name), "JOBS", hj?.tomorrowsJobs.map((j) => `${j.id} ${j.pickupCity}→${j.deliveryCity} ${j.pickup}${j.endsNearHome ? " (ends near home)" : ""}`))

const wrong = await t.buildDoubleRecoveryProposal({
  driverInTime: true, reasoningTrace: ["a", "b", "c"],
  move1: { standbyDriverId: "drv-999", note: "x" }, move2: { hotelId: "hotel-x", nextJobId: "mkt-2401", note: "y" }, customerNote: "z",
})
console.log("GUARD", wrong)
assert.equal(wrong.ok, false)
assert.equal((wrong as { problems: string[] }).problems.length, 4)

const offline = await t.buildDoubleRecoveryWithoutModel()
console.log("OFFLINE PROPOSAL", JSON.stringify(offline, null, 1))
assert.ok(offline && offline.driverInTime === false)
console.log("\nAll double-recovery checks passed.")

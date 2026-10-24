import "server-only"

import { z } from "zod"
import { db } from "@/lib/db"
import { emit } from "./bus"
import { simNow } from "./clock"
import { cwPositions } from "./schema"
import { evaluateWatch, watchForAssignment } from "./watches"

export const PositionInput = z.object({
  assignmentId: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speedKmh: z.number().min(0).max(300).nullish(),
  accuracyM: z.number().min(0).nullish(),
  // Sim time when the phone took the reading. Late uploads keep their original time.
  observedAt: z.coerce.date().optional(),
  source: z.enum(["driver_app", "replay"]).default("driver_app"),
})
export type PositionInput = z.infer<typeof PositionInput>

export async function ingestPosition(input: PositionInput): Promise<{ accepted: boolean; state?: string; slackMin?: number | null }> {
  const now = await simNow()
  const watch = await watchForAssignment(input.assignmentId)
  if (!watch) return { accepted: false }
  const observedAt = input.observedAt ?? now
  await db.insert(cwPositions).values({
    assignmentId: input.assignmentId, lat: input.lat, lng: input.lng, speedKmh: input.speedKmh ?? null,
    accuracyM: input.accuracyM ?? null, observedAt, receivedAt: now, source: input.source,
  })
  emit({ type: "position", assignmentId: input.assignmentId, orderId: watch.orderId, lat: input.lat, lng: input.lng, speedKmh: input.speedKmh ?? null, observedAt: observedAt.toISOString() })
  const updated = await evaluateWatch(watch, now)
  return { accepted: true, state: updated.state, slackMin: updated.slackMin }
}

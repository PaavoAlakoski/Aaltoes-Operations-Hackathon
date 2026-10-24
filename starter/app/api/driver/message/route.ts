import { NextResponse } from "next/server"
import { z } from "zod"
import { ensureServices } from "@/lib/boot"
import { db } from "@/lib/db"
import { deliver } from "@/lib/agent/service"
import { emit } from "@/lib/watch/bus"
import { simNow } from "@/lib/watch/clock"
import { cwMessages } from "@/lib/watch/schema"

export const runtime = "nodejs"

// A message from the driver app (a real person, or someone testing). Reaches the agent as data.
const Body = z.object({ orderId: z.string().min(1), body: z.string().trim().min(1).max(1000) })

export async function POST(request: Request) {
  ensureServices()
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Give an orderId and body" }, { status: 400 })
  const { orderId, body } = parsed.data
  const now = await simNow()
  await db.insert(cwMessages).values({ orderId, runId: null, party: "driver", direction: "in", body, quickReplies: [], at: now })
  emit({ type: "message", orderId, party: "driver", direction: "in", body, quickReplies: [], at: now.toISOString() })
  const runId = await deliver(orderId, { kind: "driver_reply", body, at: now.toISOString() }, { start: false })
  return NextResponse.json({ delivered: Boolean(runId) })
}

import { NextResponse } from "next/server"
import { z } from "zod"
import { ensureServices } from "@/lib/boot"
import { db } from "@/lib/db"
import { deliver } from "@/lib/agent/service"
import { emit } from "@/lib/watch/bus"
import { simNow } from "@/lib/watch/clock"
import { cwMessages } from "@/lib/watch/schema"

export const runtime = "nodejs"

// An operator talks to the agent about an order. Reaches the agent as operator authority.
const Body = z.object({ orderId: z.string().min(1), text: z.string().trim().min(1).max(2000), operator: z.string().trim().min(1).default("Operator") })

export async function POST(request: Request) {
  ensureServices()
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Give an orderId and text" }, { status: 400 })
  const { orderId, text, operator } = parsed.data
  const now = await simNow()
  await db.insert(cwMessages).values({ orderId, runId: null, party: "operator", direction: "to_agent", body: text, quickReplies: [], at: now })
  emit({ type: "message", orderId, party: "operator", direction: "to_agent", body: text, quickReplies: [], at: now.toISOString() })
  const runId = await deliver(orderId, { kind: "operator_message", body: text, operator, at: now.toISOString() }, { start: true, trigger: "OPERATOR_MESSAGE" })
  return NextResponse.json({ runId })
}

import { NextResponse } from "next/server"
import { z } from "zod"
import { ensureServices } from "@/lib/boot"
import { deliver } from "@/lib/agent/service"
import { simNow } from "@/lib/watch/clock"

export const runtime = "nodejs"

// Ask the agent to look at an order now, without waiting for a watch trigger.
const Body = z.object({ orderId: z.string().min(1) })

export async function POST(request: Request) {
  ensureServices()
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Give an orderId" }, { status: 400 })
  const now = await simNow()
  const runId = await deliver(parsed.data.orderId, { kind: "trigger", from: null, to: "ASKED_BY_OPERATOR", at: now.toISOString() }, { start: true, trigger: "ASKED_BY_OPERATOR" })
  return NextResponse.json({ runId })
}

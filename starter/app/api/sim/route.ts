import { NextResponse } from "next/server"
import { z } from "zod"
import { getClock } from "@/lib/watch/clock"
import { ensureServices } from "@/lib/boot"
import { inject, pause, play, resetScenario, runnerStatus } from "@/lib/watch/runner"

export const runtime = "nodejs"

// Demo controls. Not part of the operator interface.
const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reset") }),
  z.object({ action: z.literal("play"), speed: z.number().positive().max(600).optional() }),
  z.object({ action: z.literal("pause") }),
  z.object({
    action: z.literal("inject"), orderId: z.string(), kind: z.enum(["jam", "offline"]),
    durationMin: z.number().positive().max(600).optional(), speedKmh: z.number().min(0).max(60).optional(),
  }),
])

export async function GET() {
  ensureServices()
  return NextResponse.json({ clock: await getClock(), ...runnerStatus() })
}

export async function POST(request: Request) {
  const parsed = Action.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Invalid action", issues: parsed.error.issues }, { status: 400 })
  ensureServices()
  const a = parsed.data
  if (a.action === "reset") await resetScenario()
  else if (a.action === "play") await play(a.speed)
  else if (a.action === "pause") await pause()
  else await inject(a.orderId, a.kind, a.durationMin, a.speedKmh)
  return NextResponse.json({ clock: await getClock(), ...runnerStatus() })
}

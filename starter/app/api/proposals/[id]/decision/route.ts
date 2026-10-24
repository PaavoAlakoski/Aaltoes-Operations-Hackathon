import { NextResponse } from "next/server"
import { z } from "zod"
import { ensureServices } from "@/lib/boot"
import { decide } from "@/lib/agent/executor"

export const runtime = "nodejs"

const Body = z.object({
  decision: z.enum(["approved", "rejected", "changed"]),
  note: z.string().trim().max(2000).nullish(),
  operator: z.string().trim().min(1).default("Operator"),
})

export async function POST(request: Request, ctx: RouteContext<"/api/proposals/[id]/decision">) {
  ensureServices()
  const { id } = await ctx.params
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Give a decision: approved, rejected or changed" }, { status: 400 })
  try {
    return NextResponse.json(await decide(id, parsed.data.decision, parsed.data.note ?? null, parsed.data.operator))
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 })
  }
}

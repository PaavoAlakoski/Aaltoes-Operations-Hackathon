import { NextResponse } from "next/server"
import { ensureServices } from "@/lib/boot"
import { ingestPosition, PositionInput } from "@/lib/watch/ingest"

export const runtime = "nodejs"

// The driver app posts its GPS readings here. Readings taken offline arrive later with their own observedAt.
export async function POST(request: Request) {
  ensureServices()
  const parsed = PositionInput.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "Invalid position", issues: parsed.error.issues }, { status: 400 })
  const result = await ingestPosition(parsed.data)
  if (!result.accepted) return NextResponse.json({ error: "No active watch for this assignment" }, { status: 404 })
  return NextResponse.json(result)
}

import { NextResponse } from "next/server"
import { getClock } from "@/lib/watch/clock"
import { ensureServices } from "@/lib/boot"
import { listWatches } from "@/lib/watch/watches"

export const runtime = "nodejs"

export async function GET() {
  ensureServices()
  const [clock, watches] = await Promise.all([getClock(), listWatches()])
  return NextResponse.json({ clock, watches })
}

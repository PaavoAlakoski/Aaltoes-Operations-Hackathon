import { NextResponse } from "next/server"
import { listDecisions } from "@/lib/control-room"
import { loadBoardBundles } from "@/lib/present/load"
import { buildQueue } from "@/lib/present/triage"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const [{ snapshotAt, bundles }, decisions] = await Promise.all([loadBoardBundles(), listDecisions()])
  return NextResponse.json(buildQueue(bundles, decisions, snapshotAt))
}

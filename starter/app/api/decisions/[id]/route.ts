import { NextResponse } from "next/server"
import { undoDecision } from "@/lib/control-room"

export const runtime = "nodejs"

/** Undo a decision. The item it was about comes back as it was. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  return await undoDecision(id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: "Decision not found" }, { status: 404 })
}

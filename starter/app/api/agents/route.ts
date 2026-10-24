import { eq } from "drizzle-orm"
import { NextResponse } from "next/server"
import { autonomyLevels, listDecisions, setAutonomy } from "@/lib/control-room"
import { db } from "@/lib/db"
import { ACTION_KINDS, type AgentRecord, type AgentsView, type Level, LEVELS } from "@/lib/present/autonomy"
import { humanize } from "@/lib/present/labels"
import { relatedRecords } from "@/lib/schema"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const [agentRows, proposalRows, decisions, levels] = await Promise.all([
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "agents")),
    db.select().from(relatedRecords).where(eq(relatedRecords.collection, "agent_proposals")),
    listDecisions(),
    autonomyLevels(),
  ])
  // An agent's record: what it proposed and what people did with it, in the
  // snapshot and in this control room.
  const latest = new Map(decisions.map((decision) => [decision.targetId, decision]))
  const agents: AgentRecord[] = agentRows.map((row) => {
    const mine = proposalRows.filter((proposal) => proposal.details.proposed_by_agent_id === row.id)
    const record: AgentRecord = { id: row.id, title: String(row.details.title ?? row.id), scope: humanize(String(row.details.scope ?? "")), proposed: mine.length, approved: 0, changed: 0, rejected: 0, failed: 0, waiting: 0 }
    for (const proposal of mine) {
      const decision = latest.get(proposal.id)
      const status = String(proposal.details.status)
      const review = (proposal.details.review ?? null) as { decision?: string } | null
      if (decision) {
        if (decision.action === "approve" || decision.action === "retry") record.approved += 1
        else if (decision.action === "change") record.changed += 1
        else if (decision.action === "reject") record.rejected += 1
        continue
      }
      if (status === "FAILED") record.failed += 1
      if (status === "PENDING_REVIEW") record.waiting += 1
      else if (review?.decision === "EDITED") record.changed += 1
      else if (review?.decision === "REJECTED" || status === "REJECTED") record.rejected += 1
      else if (review?.decision === "APPROVED") record.approved += 1
    }
    return record
  })
  const body: AgentsView = { agents, kinds: ACTION_KINDS.map((kind) => ({ ...kind, level: kind.locked ? kind.defaultLevel : levels[kind.key] ?? kind.defaultLevel })) }
  return NextResponse.json(body)
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => null) as { key?: unknown; level?: unknown } | null
  const kind = ACTION_KINDS.find((entry) => entry.key === body?.key)
  if (!kind) return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  if (kind.locked) return NextResponse.json({ error: kind.lockReason ?? "This rule cannot be changed" }, { status: 403 })
  if (!LEVELS.some((level) => level.key === body?.level)) return NextResponse.json({ error: "Unknown level" }, { status: 400 })
  await setAutonomy(kind.key, body!.level as Level)
  return new NextResponse(null, { status: 204 })
}

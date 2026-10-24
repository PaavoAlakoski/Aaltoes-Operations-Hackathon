import "server-only"

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { and, asc, count, desc, eq, inArray } from "drizzle-orm"
import { db } from "@/lib/db"
import { emit } from "@/lib/watch/bus"
import { cwAgentRuns, cwAgentSteps } from "@/lib/watch/schema"
import type { AgentEvent, MessageParam, RunRecord, RunStatus, RunStore, StepRecord, ToolResultBlock } from "./types"

// Postgres-backed run store. Every model call and tool call is also appended to
// traces/<run>.jsonl at the repo root, so a run can be read without the app.

export const TRACE_DIR = process.env.TRACE_DIR ?? path.join(process.cwd(), "..", "traces")
const OPEN: RunStatus[] = ["running", "waiting", "awaiting_decision"]

type Row = typeof cwAgentRuns.$inferSelect

function fromRow(row: Row): RunRecord {
  return {
    id: row.id, orderId: row.orderId, watchId: row.watchId, trigger: row.trigger, status: row.status as RunStatus,
    outcomeSummary: row.outcomeSummary, messages: row.messages as MessageParam[],
    suspendedToolUseIds: row.suspendedToolUseIds, pendingToolResults: row.pendingToolResults as ToolResultBlock[],
    waitUntil: row.waitUntil, waitReason: row.waitReason, modelCalls: row.modelCalls, toolCalls: row.toolCalls,
    inputTokens: row.inputTokens, outputTokens: row.outputTokens,
  }
}

export async function loadRun(id: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(cwAgentRuns).where(eq(cwAgentRuns.id, id))
  return row ? fromRow(row) : null
}

export async function openRunForOrder(orderId: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(cwAgentRuns)
    .where(and(eq(cwAgentRuns.orderId, orderId), inArray(cwAgentRuns.status, OPEN)))
    .orderBy(desc(cwAgentRuns.startedAt)).limit(1)
  return row ? fromRow(row) : null
}

export async function latestRunForOrder(orderId: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(cwAgentRuns).where(eq(cwAgentRuns.orderId, orderId)).orderBy(desc(cwAgentRuns.startedAt)).limit(1)
  return row ? fromRow(row) : null
}

export async function waitingRunsDue(now: Date): Promise<RunRecord[]> {
  const rows = await db.select().from(cwAgentRuns).where(eq(cwAgentRuns.status, "waiting"))
  return rows.filter((r) => r.waitUntil && r.waitUntil <= now).map(fromRow)
}

export async function createRun(input: { orderId: string; watchId: string | null; trigger: string; at: Date; status?: RunStatus; outcomeSummary?: string }): Promise<RunRecord> {
  const id = `run-${input.orderId.replace("ord-", "")}-${Date.now().toString(36)}`
  const [row] = await db.insert(cwAgentRuns).values({
    id, orderId: input.orderId, watchId: input.watchId, trigger: input.trigger, status: input.status ?? "running",
    outcomeSummary: input.outcomeSummary ?? null, startedAt: input.at,
  }).returning()
  emit({ type: "agent", orderId: input.orderId, runId: id, what: "status", status: row.status, at: input.at.toISOString() })
  return fromRow(row)
}

export async function pushInbox(runId: string, event: AgentEvent): Promise<void> {
  const [row] = await db.select({ inbox: cwAgentRuns.inbox }).from(cwAgentRuns).where(eq(cwAgentRuns.id, runId))
  await db.update(cwAgentRuns).set({ inbox: [...(row?.inbox ?? []), event] }).where(eq(cwAgentRuns.id, runId))
}

export async function takeInbox(runId: string): Promise<AgentEvent[]> {
  const [row] = await db.select({ inbox: cwAgentRuns.inbox }).from(cwAgentRuns).where(eq(cwAgentRuns.id, runId))
  await db.update(cwAgentRuns).set({ inbox: [] }).where(eq(cwAgentRuns.id, runId))
  return (row?.inbox ?? []) as AgentEvent[]
}

export async function stepsForRuns(runIds: string[]) {
  if (runIds.length === 0) return []
  return db.select().from(cwAgentSteps).where(inArray(cwAgentSteps.runId, runIds)).orderBy(asc(cwAgentSteps.at), asc(cwAgentSteps.id))
}

export function pgRunStore(): RunStore {
  return {
    async save(run) {
      const ended = run.status === "closed" || run.status === "needs_person"
      await db.update(cwAgentRuns).set({
        status: run.status, outcomeSummary: run.outcomeSummary, messages: run.messages,
        suspendedToolUseIds: run.suspendedToolUseIds, pendingToolResults: run.pendingToolResults,
        waitUntil: run.waitUntil, waitReason: run.waitReason, modelCalls: run.modelCalls, toolCalls: run.toolCalls,
        inputTokens: run.inputTokens, outputTokens: run.outputTokens, ...(ended ? { endedAt: new Date() } : { endedAt: null }),
      }).where(eq(cwAgentRuns.id, run.id))
      const [row] = await db.select({ orderId: cwAgentRuns.orderId }).from(cwAgentRuns).where(eq(cwAgentRuns.id, run.id))
      emit({ type: "agent", orderId: row.orderId, runId: run.id, what: "status", status: run.status, at: new Date().toISOString() })
    },
    async addStep(runId, step: StepRecord, at) {
      const [{ n }] = await db.select({ n: count() }).from(cwAgentSteps).where(eq(cwAgentSteps.runId, runId))
      await db.insert(cwAgentSteps).values({
        runId, seq: n + 1, kind: step.kind, tool: step.tool ?? null, input: step.input ?? null, output: step.output ?? null,
        summary: step.summary, evidenceRefs: step.evidenceRefs ?? [], at,
      })
      const [row] = await db.select({ orderId: cwAgentRuns.orderId }).from(cwAgentRuns).where(eq(cwAgentRuns.id, runId))
      emit({ type: "agent", orderId: row.orderId, runId, what: "step", at: at.toISOString() })
    },
    async trace(runId, entry) {
      await mkdir(TRACE_DIR, { recursive: true })
      await appendFile(path.join(TRACE_DIR, `${runId}.jsonl`), JSON.stringify(entry) + "\n")
    },
  }
}

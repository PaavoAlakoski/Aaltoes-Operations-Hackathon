import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { z } from "zod"
import { LIMITS, runBurst, toolDefinitions, wakeMessages, type BurstDeps } from "./loop"
import type { AgentTool, ContentBlock, MessageParam, ModelClient, RunRecord, RunStore, StepRecord } from "./types"

// Loop tests with a scripted fake model: no API key, no database.

const NOW = new Date("2026-10-21T09:52:00Z")

function newRun(): RunRecord {
  return {
    id: "run-1", orderId: "ord-00603", watchId: "cw-1", trigger: "TIGHTENING", status: "running", outcomeSummary: null,
    messages: [], suspendedToolUseIds: [], pendingToolResults: [], waitUntil: null, waitReason: null,
    modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0,
  }
}

const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as ContentBlock
const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as ContentBlock

// Each call returns the next scripted turn and records what the model was sent.
function scripted(turns: ContentBlock[][]): ModelClient & { seen: MessageParam[][] } {
  const seen: MessageParam[][] = []
  return {
    seen,
    async create({ messages }) {
      seen.push(structuredClone(messages))
      const content = turns.shift()
      if (!content) throw new Error("Script ran out")
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", inputTokens: 10, outputTokens: 5, raw: null }
    },
  }
}

function memoryStore(): RunStore & { steps: StepRecord[]; saves: number } {
  const s = { steps: [] as StepRecord[], saves: 0 }
  return {
    ...s,
    get steps() { return s.steps },
    get saves() { return s.saves },
    async save() { s.saves += 1 },
    async addStep(_id, step) { s.steps.push(step) },
    async trace() {},
  }
}

const calls: string[] = []
const tools: AgentTool[] = [
  { name: "get_watch_status", description: "read", schema: z.strictObject({}),
    run: async () => { calls.push("get_watch_status"); return { result: { slackMin: 40 }, summary: "Read the watch" } } },
  { name: "wait_for", description: "pause", schema: z.strictObject({ reason: z.string(), minutes: z.number() }),
    run: async (i: { reason: string; minutes: number }, ctx) => ({ result: "paused", summary: "Waiting", suspend: { status: "waiting", reason: i.reason, waitUntil: new Date(ctx.now.getTime() + i.minutes * 60000) } }) },
  { name: "propose_action", description: "gated", schema: z.strictObject({ title: z.string() }),
    run: async (i: { title: string }) => ({ result: "proposed", summary: i.title, suspend: { status: "awaiting_decision", reason: i.title } }) },
  { name: "close_run", description: "close", schema: z.strictObject({ summary: z.string() }),
    run: async (i: { summary: string }) => ({ result: "closed", summary: i.summary, suspend: { status: "closed", reason: i.summary } }) },
] as AgentTool[]

const deps = (model: ModelClient, store = memoryStore()): BurstDeps => ({ model, tools, store, system: "test", now: () => NOW })

describe("runBurst", () => {
  it("reads, then pauses on wait_for with the call left open", async () => {
    const model = scripted([
      [toolUse("t1", "get_watch_status", {})],
      [text("Asking the driver later."), toolUse("t2", "wait_for", { reason: "driver reply", minutes: 15 })],
    ])
    const run = await runBurst(newRun(), { brief: "Case brief", events: [{ kind: "trigger", from: "ON_TRACK", to: "TIGHTENING", at: NOW.toISOString() }] }, deps(model))
    assert.equal(run.status, "waiting")
    assert.deepEqual(run.suspendedToolUseIds, ["t2"])
    assert.equal(run.waitUntil?.toISOString(), "2026-10-21T10:07:00.000Z")
    // brief, assistant(t1), user(result t1), assistant(t2)
    assert.equal(run.messages.length, 4)
    assert.equal(run.messages.at(-1)!.role, "assistant")
  })

  it("wakes by answering the open call, so history stays append-only", async () => {
    const model = scripted([
      [toolUse("t1", "wait_for", { reason: "driver reply", minutes: 15 })],
      [toolUse("t2", "close_run", { summary: "Margin recovered" })],
    ])
    const d = deps(model)
    const first = await runBurst(newRun(), { brief: "Brief", events: [] }, d)
    const before = structuredClone(first.messages)
    const second = await runBurst(first, { events: [{ kind: "driver_reply", body: "Queue moving again", at: NOW.toISOString() }] }, d)
    assert.deepEqual(second.messages.slice(0, before.length), before, "earlier turns must not change")
    const wake = second.messages[before.length]
    assert.equal(wake.role, "user")
    const block = (wake.content as { type: string; tool_use_id: string; content: string }[])[0]
    assert.equal(block.tool_use_id, "t1")
    assert.match(block.content, /Queue moving again/)
    assert.equal(second.status, "closed")
    assert.equal(second.outcomeSummary, "Margin recovered")
  })

  it("holds results of tools run alongside the pausing call and sends them on wake", async () => {
    const model = scripted([[toolUse("a", "get_watch_status", {}), toolUse("b", "propose_action", { title: "Rebook" })]])
    const run = await runBurst(newRun(), { brief: "Brief", events: [] }, deps(model))
    assert.equal(run.status, "awaiting_decision")
    assert.equal(run.pendingToolResults.length, 1)
    const wake = wakeMessages(run, [{ kind: "decision", proposalId: "p1", decision: "approved", note: null, operator: "Aino", outcome: "Booked.", at: NOW.toISOString() }])
    const ids = (wake[0].content as { tool_use_id: string }[]).map((b) => b.tool_use_id)
    assert.deepEqual(ids, ["a", "b"], "all results in one user message")
  })

  it("puts an operator instruction in a system message after the wake-up", () => {
    const run = { ...newRun(), suspendedToolUseIds: ["x"] }
    const wake = wakeMessages(run, [{ kind: "operator_message", body: "No hotel.", operator: "Aino", at: NOW.toISOString() }])
    assert.equal(wake.length, 2)
    assert.equal(wake[0].role, "user")
    assert.equal(wake[1].role, "system")
    assert.match(String(wake[1].content), /No hotel/)
  })

  it("returns invalid input as an error the model can fix, without running the tool", async () => {
    const model = scripted([
      [toolUse("t1", "wait_for", { reason: 5 })],
      [toolUse("t2", "wait_for", { reason: "ok", minutes: 5 })],
    ])
    const run = await runBurst(newRun(), { brief: "Brief", events: [] }, deps(model))
    const result = (model.seen[1].at(-1)!.content as { is_error: boolean; content: string }[])[0]
    assert.equal(result.is_error, true)
    assert.match(result.content, /Invalid input/)
    assert.equal(run.status, "waiting")
  })

  it("rejects tools that do not exist, such as contacting a customer", async () => {
    const model = scripted([
      [toolUse("t1", "message_customer", { body: "Your car is late" })],
      [toolUse("t2", "close_run", { summary: "done" })],
    ])
    await runBurst(newRun(), { brief: "Brief", events: [] }, deps(model))
    const result = (model.seen[1].at(-1)!.content as { is_error: boolean; content: string }[])[0]
    assert.equal(result.is_error, true)
    assert.match(result.content, /no tool called message_customer/)
  })

  it("nudges once when the model ends a turn without pausing, then parks the run", async () => {
    const model = scripted([[text("I think it is fine.")], [text("Still fine.")]])
    const run = await runBurst(newRun(), { brief: "Brief", events: [] }, deps(model))
    assert.equal(model.seen.length, 2)
    assert.match(String(model.seen[1].at(-1)!.content), /wait_for, propose_action or close_run/)
    assert.equal(run.status, "waiting")
  })

  it("hands the case to a person when the burst budget runs out", async () => {
    const model = scripted(Array.from({ length: LIMITS.modelCallsPerBurst }, (_, i) => [toolUse(`r${i}`, "get_watch_status", {})]))
    const store = memoryStore()
    const run = await runBurst(newRun(), { brief: "Brief", events: [] }, deps(model, store))
    assert.equal(run.status, "needs_person")
    assert.match(store.steps.at(-1)!.summary, /person should take over/)
  })

  it("stops on a refusal instead of guessing", async () => {
    const model: ModelClient = { async create() { return { content: [], stopReason: "refusal", inputTokens: 1, outputTokens: 0, raw: null } } }
    const run = await runBurst(newRun(), { brief: "Brief", events: [] }, deps(model))
    assert.equal(run.status, "needs_person")
  })
})

describe("toolDefinitions", () => {
  it("emits strict schemas without $schema", () => {
    const [def] = toolDefinitions([tools[1]])
    assert.equal(def.strict, true)
    assert.equal((def.input_schema as Record<string, unknown>).$schema, undefined)
    assert.equal((def.input_schema as Record<string, unknown>).additionalProperties, false)
  })
})

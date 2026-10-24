import { z } from "zod"
import type {
  AgentEvent, AgentTool, AssistantContent, ContentBlock, MessageParam, ModelClient, RunRecord, RunStore, ToolDefinition, ToolResultBlock,
} from "./types"

// The agent loop. One burst = model ⇄ tools until the model pauses the run with
// wait_for, propose_action or close_run. The conversation is append-only: earlier turns are
// never edited, and assistant content is stored exactly as the API returned it.

export const LIMITS = { modelCallsPerBurst: 10, toolCallsPerRun: 40 }

const NUDGE = "End this turn with one of wait_for, propose_action or close_run."

export function toolDefinitions(tools: AgentTool[]): ToolDefinition[] {
  return tools.map((tool) => {
    const { $schema: _, ...schema } = z.toJSONSchema(tool.schema) as Record<string, unknown>
    return { name: tool.name, description: tool.description, input_schema: schema as ToolDefinition["input_schema"], strict: true }
  })
}

const time = (iso: string) => iso.slice(11, 16) + " UTC"

export function describeEvents(events: AgentEvent[]): string {
  if (events.length === 0) return "Woke up with nothing new."
  return events.map((e) => {
    switch (e.kind) {
      case "trigger": return `${time(e.at)} The watch changed from ${e.from ?? "new"} to ${e.to}.`
      case "watch_state": return `${time(e.at)} The watch changed from ${e.from} to ${e.to}${e.slackMin === null ? "" : `, margin ${e.slackMin} min`}.`
      case "driver_reply": return `${time(e.at)} The driver replied: "${e.body}"`
      case "timer": return `${time(e.at)} The time you asked to wait for has passed.`
      case "operator_message": return `${time(e.at)} ${e.operator} from Bahn operations wrote to you (see the operator instruction).`
      case "decision": return `${time(e.at)} ${e.operator} ${e.decision} proposal ${e.proposalId}${e.note ? ` with the note: "${e.note}"` : ""}. ${e.outcome}`
    }
  }).join("\n")
}

// Builds the message(s) that wake a paused run: the results for the calls it paused on,
// then any operator instruction as a mid-conversation system message (operator authority,
// kept apart from driver and carrier text, which is data).
export function wakeMessages(run: RunRecord, events: AgentEvent[]): MessageParam[] {
  const text = describeEvents(events)
  const out: MessageParam[] = []
  if (run.suspendedToolUseIds.length > 0) {
    const results: ToolResultBlock[] = [
      ...run.pendingToolResults,
      ...run.suspendedToolUseIds.map((id): ToolResultBlock => ({ type: "tool_result", tool_use_id: id, content: text })),
    ]
    out.push({ role: "user", content: results })
  } else {
    out.push({ role: "user", content: text })
  }
  for (const e of events) {
    if (e.kind === "operator_message") out.push({ role: "system", content: `Instruction from ${e.operator}, Bahn operations: ${e.body}` })
  }
  return out
}

export type BurstDeps = {
  model: ModelClient
  tools: AgentTool[]
  store: RunStore
  system: string
  now: () => Date
}

export async function runBurst(run: RunRecord, wake: { brief?: string; events: AgentEvent[] }, deps: BurstDeps): Promise<RunRecord> {
  const byName = new Map(deps.tools.map((t) => [t.name, t]))
  const definitions = toolDefinitions(deps.tools)

  if (run.messages.length === 0) {
    run.messages.push({ role: "user", content: `${wake.brief ?? ""}\n\n${describeEvents(wake.events)}`.trim() })
  } else {
    run.messages.push(...wakeMessages(run, wake.events))
  }
  for (const e of wake.events) await deps.store.addStep(run.id, { kind: "event", summary: describeEvents([e]) }, deps.now())
  run.status = "running"
  run.suspendedToolUseIds = []
  run.pendingToolResults = []
  run.waitUntil = null
  run.waitReason = null
  await deps.store.save(run)

  let nudged = false
  for (let call = 0; call < LIMITS.modelCallsPerBurst; call++) {
    const response = await deps.model.create({ system: deps.system, tools: definitions, messages: run.messages })
    run.modelCalls += 1
    run.inputTokens += response.inputTokens
    run.outputTokens += response.outputTokens
    await deps.store.trace(run.id, { type: "model_call", at: deps.now().toISOString(), stopReason: response.stopReason, usage: { input: response.inputTokens, output: response.outputTokens }, content: response.content })

    if (response.stopReason === "refusal" || response.stopReason === "max_tokens") {
      return stop(run, deps, `The agent stopped (${response.stopReason}). A person should take this case.`)
    }
    run.messages.push({ role: "assistant", content: response.content as AssistantContent })
    await recordContent(run, response.content, deps)

    const toolUses = response.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
    if (toolUses.length === 0) {
      if (nudged) {
        run.status = "waiting"
        run.waitReason = "The agent ended its turn without choosing how to pause."
        await deps.store.save(run)
        return run
      }
      nudged = true
      run.messages.push({ role: "user", content: NUDGE })
      await deps.store.save(run)
      continue
    }

    const results: ToolResultBlock[] = []
    const suspended: { id: string; status: "waiting" | "awaiting_decision" | "closed"; waitUntil?: Date | null; reason: string }[] = []
    for (const use of toolUses) {
      run.toolCalls += 1
      const tool = byName.get(use.name)
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `There is no tool called ${use.name}.`, is_error: true })
        continue
      }
      const parsed = tool.schema.safeParse(use.input)
      if (!parsed.success) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Invalid input: ${parsed.error.message}`, is_error: true })
        continue
      }
      let outcome
      try {
        outcome = await tool.run(parsed.data, { run, now: deps.now() })
      } catch (error) {
        outcome = { result: `The tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true, summary: `${use.name} failed` }
      }
      await deps.store.addStep(run.id, { kind: "tool_call", tool: use.name, input: parsed.data, output: outcome.result, summary: outcome.summary, evidenceRefs: outcome.evidenceRefs }, deps.now())
      await deps.store.trace(run.id, { type: "tool", at: deps.now().toISOString(), name: use.name, input: parsed.data, result: outcome.result, isError: outcome.isError ?? false })
      if (outcome.suspend && !outcome.isError) {
        suspended.push({ id: use.id, ...outcome.suspend })
      } else {
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(outcome.result), is_error: outcome.isError })
      }
    }

    if (suspended.length > 0) {
      // close_run wins over a decision wait, which wins over a plain wait.
      const rank = { closed: 3, awaiting_decision: 2, waiting: 1 } as const
      const top = suspended.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a))
      run.status = top.status
      run.waitUntil = top.status === "waiting" ? top.waitUntil ?? null : null
      run.waitReason = top.reason
      if (top.status === "closed") run.outcomeSummary = top.reason
      run.suspendedToolUseIds = suspended.map((s) => s.id)
      run.pendingToolResults = results
      await deps.store.save(run)
      await deps.store.addStep(run.id, { kind: "status", summary: statusLine(run) }, deps.now())
      return run
    }

    run.messages.push({ role: "user", content: results })
    await deps.store.save(run)
    if (run.toolCalls >= LIMITS.toolCallsPerRun) return stop(run, deps, "The agent used its tool budget for this case without finishing. A person should take over.")
  }
  return stop(run, deps, "The agent took too many steps in one go. A person should take over.")
}

function statusLine(run: RunRecord): string {
  if (run.status === "closed") return `Closed: ${run.outcomeSummary}`
  if (run.status === "awaiting_decision") return `Waiting for a person to decide: ${run.waitReason}`
  return `Waiting: ${run.waitReason}`
}

async function stop(run: RunRecord, deps: BurstDeps, reason: string): Promise<RunRecord> {
  run.status = "needs_person"
  run.outcomeSummary = reason
  await deps.store.save(run)
  await deps.store.addStep(run.id, { kind: "status", summary: reason }, deps.now())
  return run
}

async function recordContent(run: RunRecord, content: ContentBlock[], deps: BurstDeps) {
  for (const block of content) {
    if (block.type === "thinking" && block.thinking.trim()) {
      await deps.store.addStep(run.id, { kind: "thinking", summary: block.thinking.trim() }, deps.now())
    } else if (block.type === "text" && block.text.trim()) {
      await deps.store.addStep(run.id, { kind: "text", summary: block.text.trim() }, deps.now())
    }
  }
}

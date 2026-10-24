import type Anthropic from "@anthropic-ai/sdk"
import type { z } from "zod"
import type { EvidenceRef } from "@/lib/watch/schema"

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam
export type AssistantContent = Anthropic.Beta.Messages.BetaAssistantMessageParam["content"]
export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock
export type ToolResultBlock = Anthropic.Beta.Messages.BetaToolResultBlockParam
export type ToolDefinition = Anthropic.Beta.Messages.BetaTool

// Something that happened while a run was paused. It becomes the content of the wake-up.
export type AgentEvent =
  | { kind: "trigger"; from: string | null; to: string; at: string }
  | { kind: "watch_state"; from: string; to: string; slackMin: number | null; at: string }
  | { kind: "driver_reply"; body: string; at: string }
  | { kind: "timer"; at: string }
  | { kind: "operator_message"; body: string; operator: string; at: string }
  | { kind: "decision"; proposalId: string; decision: "approved" | "rejected" | "changed"; note: string | null; operator: string; outcome: string; at: string }

export type RunStatus = "running" | "waiting" | "awaiting_decision" | "closed" | "needs_person"

export type RunRecord = {
  id: string
  orderId: string
  watchId: string | null
  trigger: string
  status: RunStatus
  outcomeSummary: string | null
  messages: MessageParam[]
  suspendedToolUseIds: string[]
  pendingToolResults: ToolResultBlock[]
  waitUntil: Date | null
  waitReason: string | null
  modelCalls: number
  toolCalls: number
  inputTokens: number
  outputTokens: number
}

export type StepRecord = {
  kind: "event" | "thinking" | "text" | "tool_call" | "status"
  tool?: string
  input?: unknown
  output?: unknown
  summary: string
  evidenceRefs?: EvidenceRef[]
}

// What a tool returns to the loop. `suspend` pauses the run after this turn; the tool's
// result is then produced by the next wake-up instead of now.
export type ToolOutcome = {
  result: unknown
  isError?: boolean
  summary: string
  evidenceRefs?: EvidenceRef[]
  suspend?: { status: "waiting" | "awaiting_decision" | "closed"; waitUntil?: Date | null; reason: string }
}

export type ToolContext = {
  run: RunRecord
  now: Date
}

export type AgentTool<S extends z.ZodType = z.ZodType> = {
  name: string
  description: string
  schema: S
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>
}

// Keeps each tool's input typed from its schema while letting tools live in one list.
export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool {
  return tool as unknown as AgentTool
}

export type ModelResponse = {
  content: ContentBlock[]
  stopReason: string | null
  inputTokens: number
  outputTokens: number
  raw: unknown
}

export interface ModelClient {
  create(args: { system: string; tools: ToolDefinition[]; messages: MessageParam[] }): Promise<ModelResponse>
}

export interface RunStore {
  save(run: RunRecord): Promise<void>
  addStep(runId: string, step: StepRecord, at: Date): Promise<void>
  trace(runId: string, entry: Record<string, unknown>): Promise<void>
}

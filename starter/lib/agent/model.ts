import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import type { ModelClient } from "./types"

export const AGENT_MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5"
export const DRIVER_MODEL = process.env.DRIVER_MODEL ?? "claude-haiku-5-5"
const EFFORT = (process.env.AGENT_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max"

// The SDK also finds credentials from an `ant auth login` profile; AGENT_MODE=live forces the agent on.
export function agentEnabled(): boolean {
  if (process.env.AGENT_MODE === "off") return false
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.AGENT_MODE === "live")
}

let client: Anthropic | null = null
const anthropic = () => (client ??= new Anthropic())

export function anthropicModel(): ModelClient {
  return {
    async create({ system, tools, messages }) {
      const response = await anthropic().beta.messages.create({
        model: AGENT_MODEL,
        max_tokens: 16000,
        system,
        tools,
        messages,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: EFFORT },
        // Caches the frozen tools + system prefix and the growing conversation.
        cache_control: { type: "ephemeral" },
        // A rare false-positive refusal is retried on Anthropic's recommended model instead of ending the run.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      })
      return {
        content: response.content,
        stopReason: response.stop_reason,
        inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
        raw: { id: response.id, model: response.model, usage: response.usage },
      }
    },
  }
}

// A plain call for the simulated driver: short, cheap, no tools.
export async function driverReply(system: string, prompt: string): Promise<string> {
  const response = await anthropic().messages.create({
    model: DRIVER_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low" },
  })
  if (response.stop_reason === "refusal") return "OK"
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim() || "OK"
}

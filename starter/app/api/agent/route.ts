import { anthropic } from "@ai-sdk/anthropic"
import { generateText, isStepCount } from "ai"
import { NextResponse } from "next/server"
import { buildDoubleRecoveryWithoutModel, doubleRecoveryTools, type DoubleRecoveryProposal } from "@/lib/agent-tools"
import { SCENARIO } from "@/lib/mock-data"

export const runtime = "nodejs"
export const maxDuration = 120

// claude-3-5-sonnet-20240620 is retired and rejected by the API; the current default is used instead.
const MODEL = process.env.RECOVERY_MODEL ?? "claude-opus-5-5"

const SYSTEM = `You are Bahn's recovery agent. A freelance driver is travelling by train to collect a car at a dealer, and the train is delayed.

Work in this order, using the tools:
1. check_telemetry: when can the driver be at the dealer? Use the computed times; do not do your own clock arithmetic.
2. check_dealer_policy: when does the dealer close, and can keys be collected after closing? PERSONAL_ONLY means no.
3. Decide whether the driver is in time. If they arrive after closing and the handover is PERSONAL_ONLY, the pickup will fail with this driver.
4. find_standby_driver near the dealer, for Move 1.
5. find_hotel_and_next_job for the stranded driver, in the city where the train ends tonight, for Move 2.
6. generate_reshuffle_proposal with driverInTime, a reasoningTrace of short lines with the actual numbers (e.g. "ETA 19:20 > dealer closes 19:00, keys PERSONAL_ONLY"), and both moves. If it returns problems, fix them and call it again.

Rules: you propose, a person decides. Nothing is booked, assigned or sent by you. Never contact the customer; customerNote is a draft for a person. Standby availability is not confirmed and hotels and jobs are mock quotes: say so in the notes. Use only ids returned by the tools. End after the proposal is accepted by generate_reshuffle_proposal.`

type ProposalResult = { ok: true; proposal: DoubleRecoveryProposal } | { ok: false; problems: string[] }

// POST { mode?: "model" | "offline" } → { proposal, steps }
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { mode?: string }
  if (body.mode === "offline") {
    const proposal = await buildDoubleRecoveryWithoutModel()
    if (!proposal) return NextResponse.json({ error: "The scenario data could not be loaded." }, { status: 500 })
    return NextResponse.json({ proposal, steps: [], model: null })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "No ANTHROPIC_API_KEY on the server. Use the version computed without the model, or add a key." }, { status: 503 })
  }

  try {
    const result = await generateText({
      model: anthropic(MODEL),
      system: SYSTEM,
      prompt: `Order ${SCENARIO.orderId} (${SCENARIO.title}). The driver is ${SCENARIO.driverId}. Analyse the delay and prepare the Double Recovery proposal.`,
      tools: doubleRecoveryTools,
      stopWhen: isStepCount(10),
    })
    // The last accepted proposal wins; earlier rejected attempts stay in the trace.
    const results = result.steps.flatMap((step) => step.toolResults)
    const accepted = results
      .filter((r) => r.toolName === "generate_reshuffle_proposal")
      .map((r) => r.output as ProposalResult)
      .filter((o): o is Extract<ProposalResult, { ok: true }> => o.ok)
      .at(-1)
    const steps = result.steps.flatMap((step) => step.toolCalls.map((call) => ({ tool: call.toolName, input: call.input })))
    if (!accepted) return NextResponse.json({ error: "The agent did not produce an accepted proposal.", steps, text: result.text }, { status: 502 })
    return NextResponse.json({ proposal: accepted.proposal, steps, model: MODEL })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}

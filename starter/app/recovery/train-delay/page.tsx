"use client"

import { useEffect, useState } from "react"
import { DoubleRecoveryPanel } from "@/app/components/ImpactTree"
import type { DoubleRecoveryProposal } from "@/lib/agent-tools"

// The train-delay scenario on its own page: ask the agent, then decide on its two moves.

type Answer = { proposal?: DoubleRecoveryProposal; steps?: { tool: string }[]; model?: string | null; error?: string }

export default function TrainDelayPage() {
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [busy, setBusy] = useState<"model" | "offline" | null>(null)

  // ?run=offline or ?run=model starts straight away, for demo links and recordings.
  useEffect(() => {
    const mode = new URLSearchParams(window.location.search).get("run")
    if (mode === "offline" || mode === "model") void run(mode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(mode: "model" | "offline") {
    setBusy(mode)
    setAnswer(null)
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) })
      setAnswer((await res.json()) as Answer)
    } catch (error) {
      setAnswer({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="m-0 text-2xl font-bold">Train delay on the way to a Frankfurt pickup</h1>
      <p className="mt-1 text-stone-600">CD-420992 · Cole Mervalen&apos;s train from Hamburg has stopped. Demo scenario on 22 Oct, the day after the snapshot.</p>
      <div className="my-6 flex flex-wrap gap-3">
        <button type="button" disabled={busy !== null} onClick={() => run("model")} className="cursor-pointer rounded-lg border-0 bg-stone-900 px-4 py-2.5 font-semibold! text-white! disabled:opacity-50">
          {busy === "model" ? "The agent is checking…" : "Ask the agent"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => run("offline")} className="cursor-pointer rounded-lg border border-stone-400 bg-transparent px-4 py-2.5 font-semibold! text-stone-800! disabled:opacity-50">
          {busy === "offline" ? "Computing…" : "Show it without the model"}
        </button>
      </div>
      {!answer && !busy && <p className="text-stone-500">Nothing checked yet. The agent reads the train telemetry and the dealer&apos;s rules, then proposes what to do.</p>}
      {answer?.error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-red-800">{answer.error}</p>}
      {answer?.proposal && <DoubleRecoveryPanel proposal={answer.proposal} />}
      {answer?.steps && answer.steps.length > 0 && (
        <p className="text-sm text-stone-500">Agent steps ({answer.model}): {answer.steps.map((s) => s.tool).join(" → ")}</p>
      )}
    </main>
  )
}

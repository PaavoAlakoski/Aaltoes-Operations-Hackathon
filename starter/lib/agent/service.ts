import "server-only"

import { subscribe, type WatchEvent } from "@/lib/watch/bus"
import { getClock, setClock, simNowSync } from "@/lib/watch/clock"
import { runBurst } from "./loop"
import { agentEnabled, anthropicModel } from "./model"
import { caseBrief, SYSTEM_PROMPT } from "./prompt"
import { onAgentMessagedDriver, resetSimDriver, simDriverTick } from "./sim-driver"
import { createRun, latestRunForOrder, loadRun, openRunForOrder, pgRunStore, pushInbox, takeInbox, waitingRunsDue } from "./store"
import { agentTools, resetSlots } from "./tools"
import type { AgentEvent, ModelClient } from "./types"
import { watchForOrder } from "./context"

// Wires the agent to the world: watch triggers start runs, everything else wakes the open run.
// Runs are processed one burst at a time per order; events that arrive mid-burst queue in the inbox.

// While the model thinks, sim time slows to this speed so a 20-second call is not 20 sim minutes.
export const AGENT_PACE_SPEED = Number(process.env.AGENT_PACE_SPEED ?? 4)

type ServiceState = {
  instance: symbol
  unsubscribe: (() => void) | null
  busy: Set<string>
  watchStates: Map<string, string>
  activeBursts: number
  savedSpeed: number | null
  model: ModelClient | null
  ticking: boolean
}
const INSTANCE = Symbol("agent-service")
const holder = globalThis as unknown as { __cwAgent?: ServiceState }

function state(): ServiceState {
  if (holder.__cwAgent && holder.__cwAgent.instance !== INSTANCE) {
    holder.__cwAgent.unsubscribe?.()
    holder.__cwAgent = undefined
  }
  return holder.__cwAgent ??= { instance: INSTANCE, unsubscribe: null, busy: new Set(), watchStates: new Map(), activeBursts: 0, savedSpeed: null, model: null, ticking: false }
}

// Tests and scripts can swap the model.
export function setModelForTesting(model: ModelClient | null) { state().model = model }

export function ensureAgentService(): void {
  const s = state()
  if (s.unsubscribe) return
  s.unsubscribe = subscribe((event) => { void onEvent(event) })
}

async function onEvent(event: WatchEvent) {
  try {
    if (event.type === "trigger") {
      await deliver(event.orderId, { kind: "trigger", from: event.from, to: event.to, at: event.at }, { start: true, trigger: event.to })
    } else if (event.type === "watch") {
      const s = state()
      const before = s.watchStates.get(event.watchId)
      s.watchStates.set(event.watchId, event.state)
      // Worse states arrive as triggers; this carries the rest (recovery, arrival) to an open run.
      if (before && before !== event.state) {
        await deliver(event.orderId, { kind: "watch_state", from: before, to: event.state, slackMin: event.slackMin, at: event.at }, { start: false, skipIfTriggered: true })
      }
    } else if (event.type === "tick") {
      await onTick(new Date(event.simNow))
    } else if (event.type === "reset") {
      state().watchStates.clear()
      resetSimDriver()
      resetSlots()
    }
  } catch (error) {
    console.error("[agent service]", error)
  }
}

async function onTick(now: Date) {
  const s = state()
  if (s.ticking) return
  s.ticking = true
  try {
    for (const run of await waitingRunsDue(now)) await deliver(run.orderId, { kind: "timer", at: now.toISOString() }, { start: false })
    await simDriverTick(now, async (orderId, body, at) => { await deliver(orderId, { kind: "driver_reply", body, at: at.toISOString() }, { start: false }) })
  } finally {
    s.ticking = false
  }
}

const recentTriggers = new Map<string, number>()

// Hands an event to the order's open run, starting one for triggers and reopening a closed run
// for operator messages. The burst runs in the background.
export async function deliver(orderId: string, event: AgentEvent, opts: { start: boolean; trigger?: string; skipIfTriggered?: boolean }): Promise<string | null> {
  if (event.kind === "trigger") recentTriggers.set(orderId, Date.now())
  // A trigger and a state event for the same change arrive together; the trigger is enough.
  if (opts.skipIfTriggered && Date.now() - (recentTriggers.get(orderId) ?? 0) < 2000) return null

  let run = await openRunForOrder(orderId)
  if (!run && event.kind === "operator_message") {
    const latest = await latestRunForOrder(orderId)
    if (latest && latest.messages.length > 0) run = latest
  }
  if (!run && opts.start) {
    const watch = await watchForOrder(orderId)
    const at = new Date(event.at)
    if (!agentEnabled()) {
      await createRun({ orderId, watchId: watch?.id ?? null, trigger: opts.trigger ?? event.kind, at, status: "needs_person", outcomeSummary: "The agent is off (no API key), so nothing was checked. A person should look at this signal." })
      return null
    }
    run = await createRun({ orderId, watchId: watch?.id ?? null, trigger: opts.trigger ?? event.kind, at })
  }
  if (!run) return null
  await pushInbox(run.id, event)
  void processRun(run.id)
  return run.id
}

async function processRun(runId: string): Promise<void> {
  const s = state()
  if (s.busy.has(runId) || !agentEnabled()) return
  s.busy.add(runId)
  try {
    for (;;) {
      const run = await loadRun(runId)
      if (!run) return
      const events = await takeInbox(runId)
      const isNew = run.messages.length === 0
      if (!isNew && events.length === 0) return
      if (run.status === "needs_person") return
      await paceStart()
      try {
        const now = simNowSync()
        const brief = isNew ? await caseBrief(run.orderId, now) : undefined
        await runBurst(run, { brief, events }, {
          model: s.model ?? anthropicModel(),
          tools: agentTools({ onDriverMessage: onAgentMessagedDriver }),
          store: pgRunStore(),
          system: SYSTEM_PROMPT,
          now: simNowSync,
        })
      } catch (error) {
        console.error("[agent burst]", error)
        const failed = await loadRun(runId)
        if (failed) {
          failed.status = "needs_person"
          failed.outcomeSummary = `The agent hit an error and stopped: ${error instanceof Error ? error.message : String(error)}`
          await pgRunStore().save(failed)
        }
        return
      } finally {
        await paceEnd()
      }
    }
  } finally {
    s.busy.delete(runId)
  }
}

async function paceStart() {
  const s = state()
  s.activeBursts += 1
  if (s.activeBursts > 1) return
  const clock = await getClock()
  if (clock && clock.speed > AGENT_PACE_SPEED) {
    s.savedSpeed = clock.speed
    await setClock({ speed: AGENT_PACE_SPEED })
  }
}

async function paceEnd() {
  const s = state()
  s.activeBursts = Math.max(0, s.activeBursts - 1)
  if (s.activeBursts > 0 || s.savedSpeed === null) return
  const clock = await getClock()
  // Only restore if nobody changed the speed meanwhile (pause stays paused).
  if (clock && clock.speed === AGENT_PACE_SPEED) await setClock({ speed: s.savedSpeed })
  s.savedSpeed = null
}

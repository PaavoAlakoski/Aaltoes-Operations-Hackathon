import { EventEmitter } from "node:events"

// In-process event bus behind the SSE stream. One Next.js server process is enough for the demo.

export type WatchEvent =
  | { type: "clock"; simNow: string; speed: number }
  | { type: "watch"; watchId: string; orderId: string; assignmentId: string; state: string; slackMin: number | null; at: string }
  | { type: "position"; assignmentId: string; orderId: string; lat: number; lng: number; speedKmh: number | null; observedAt: string }
  | { type: "trigger"; watchId: string; orderId: string; from: string | null; to: string; at: string }
  | { type: "reset"; scenarioId: string }
  // Every runner tick, with the sim time. Internal: the SSE stream does not forward it.
  | { type: "tick"; simNow: string }
  | { type: "message"; orderId: string; party: string; direction: string; body: string; quickReplies: string[]; at: string }
  | { type: "agent"; orderId: string; runId: string; what: "step" | "status" | "proposal"; status?: string; at: string }
  | { type: "decision"; orderId: string; proposalId: string; decision: string; at: string }

const store = globalThis as unknown as { __cwBus?: EventEmitter }
const bus = store.__cwBus ?? (store.__cwBus = new EventEmitter().setMaxListeners(200))

export function emit(event: WatchEvent): void {
  bus.emit("event", event)
}

export function subscribe(listener: (event: WatchEvent) => void): () => void {
  bus.on("event", listener)
  return () => { bus.off("event", listener) }
}

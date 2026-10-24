import "server-only"

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { db } from "./db"
import type { DecisionAction, DecisionEffect, DecisionRecord } from "./present/decisions"
import { datasetMetadata } from "./schema"

// What people decide in the control room. It sits beside the snapshot and never
// rewrites a source record, so it lives in its own small file that survives a
// restart: starter/.data/control-room.json. Writes go to a temporary file first,
// so a stopped process never leaves half a file.

export type AutonomyLevel = "ask_first" | "act_then_tell" | "on_its_own"

type Store = {
  decisions: DecisionRecord[]
  autonomy: Record<string, { level: AutonomyLevel; updatedAt: string }>
}

const file = process.env.CONTROL_ROOM_FILE ?? join(process.cwd(), ".data", "control-room.json")

const KEY = Symbol.for("control-room.store")
const globalStore = globalThis as unknown as Record<symbol, { store: Store | null; queue: Promise<unknown> } | undefined>
const state = globalStore[KEY] ??= { store: null, queue: Promise.resolve() }

async function load(): Promise<Store> {
  if (state.store) return state.store
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<Store>
    state.store = { decisions: parsed.decisions ?? [], autonomy: parsed.autonomy ?? {} }
  } catch {
    state.store = { decisions: [], autonomy: {} }
  }
  return state.store
}

/** Run one change at a time, then save. */
function change<T>(apply: (store: Store) => T | Promise<T>): Promise<T> {
  const run = state.queue.then(async () => {
    const store = await load()
    const result = await apply(store)
    await mkdir(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(store, null, 2))
    await rename(temp, file)
    return result
  })
  state.queue = run.catch(() => undefined)
  return run
}

// The snapshot is frozen at one instant. So that decisions read in order and
// against the same "now" as everything else, the control room clock starts at
// the snapshot and runs forward with the real time this server has been up.
const started = Date.now()

export async function controlRoomNow(): Promise<Date> {
  const [meta] = await db.select({ at: datasetMetadata.snapshotAt }).from(datasetMetadata).limit(1)
  const base = meta?.at.getTime() ?? started
  return new Date(base + (Date.now() - started))
}

export async function listDecisions(orderId?: string): Promise<DecisionRecord[]> {
  const { decisions } = await load()
  return orderId ? decisions.filter((decision) => decision.orderId === orderId) : [...decisions]
}

export async function recordDecision(input: { orderId: string; targetType: string; targetId: string; action: DecisionAction; note: string | null; effects: DecisionEffect[] }): Promise<DecisionRecord> {
  const decision: DecisionRecord = { id: `dec-${randomUUID().slice(0, 12)}`, ...input, decidedBy: "you", decidedAt: (await controlRoomNow()).toISOString() }
  return change((store) => { store.decisions.push(decision); return decision })
}

export function undoDecision(id: string): Promise<boolean> {
  return change((store) => {
    const before = store.decisions.length
    store.decisions = store.decisions.filter((decision) => decision.id !== id)
    return store.decisions.length < before
  })
}

export async function autonomyLevels(): Promise<Record<string, AutonomyLevel>> {
  const { autonomy } = await load()
  return Object.fromEntries(Object.entries(autonomy).map(([kind, entry]) => [kind, entry.level]))
}

export async function setAutonomy(actionKind: string, level: AutonomyLevel): Promise<void> {
  const at = (await controlRoomNow()).toISOString()
  await change((store) => { store.autonomy[actionKind] = { level, updatedAt: at } })
}

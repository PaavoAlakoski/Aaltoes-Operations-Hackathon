import "server-only"

import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { cwSimClock } from "./schema"
import { emit } from "./bus"

// The demo clock. Sim time = base sim time + real time elapsed × speed. Speed 0 is paused.
// Kept in memory for every read and written through to Postgres so a restart resumes.

const ID = "demo"
type ClockRow = typeof cwSimClock.$inferSelect

const store = globalThis as unknown as { __cwClock?: ClockRow }

export function simNowFrom(row: ClockRow, real = new Date()): Date {
  return new Date(row.baseSimAt.getTime() + (real.getTime() - row.baseRealAt.getTime()) * row.speed)
}

async function load(): Promise<ClockRow | null> {
  if (store.__cwClock) return store.__cwClock
  const [row] = await db.select().from(cwSimClock).where(eq(cwSimClock.id, ID))
  if (row) store.__cwClock = row
  return row ?? null
}

export async function getClock(): Promise<{ simNow: Date; speed: number; scenarioId: string | null } | null> {
  const row = await load()
  return row ? { simNow: simNowFrom(row), speed: row.speed, scenarioId: row.scenarioId } : null
}

// Sync read from the in-memory clock, for code inside a running tick or agent burst.
export function simNowSync(): Date {
  if (!store.__cwClock) throw new Error("Demo clock is not loaded yet")
  return simNowFrom(store.__cwClock)
}

export async function simNow(): Promise<Date> {
  const row = await load()
  if (!row) throw new Error("Demo clock is not set. POST /api/sim with action 'reset'.")
  return simNowFrom(row)
}

// Rebases the clock at the current instant so changing speed never jumps sim time.
export async function setClock(change: { simAt?: Date; speed?: number; scenarioId?: string | null }): Promise<void> {
  const current = await load()
  const real = new Date()
  const row: ClockRow = {
    id: ID,
    baseRealAt: real,
    baseSimAt: change.simAt ?? (current ? simNowFrom(current, real) : real),
    speed: change.speed ?? current?.speed ?? 0,
    scenarioId: change.scenarioId === undefined ? current?.scenarioId ?? null : change.scenarioId,
  }
  await db.insert(cwSimClock).values(row).onConflictDoUpdate({ target: cwSimClock.id, set: row })
  store.__cwClock = row
  emit({ type: "clock", simNow: row.baseSimAt.toISOString(), speed: row.speed })
}

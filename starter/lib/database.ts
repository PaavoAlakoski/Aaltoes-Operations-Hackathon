// Postgres in process, with PGlite. The data lives in starter/.data/pglite, so
// the app runs from a fresh clone with nothing but Node. One instance per
// process: Next can load this module from several bundles, so the instance
// lives on globalThis.

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import * as schema from "./schema"

export type Database = PgliteDatabase<typeof schema>

type Holder = { client: PGlite; db: Database; ready: Promise<void> | null }

const KEY = Symbol.for("control-room.database")
const globalHolder = globalThis as unknown as Record<symbol, Holder | undefined>

export const dataDir = process.env.PGLITE_DIR ?? join(process.cwd(), ".data", "pglite")

function holder(): Holder {
  let current = globalHolder[KEY]
  if (!current) {
    mkdirSync(dataDir, { recursive: true })
    const client = new PGlite(dataDir)
    current = { client, db: drizzle(client, { schema }), ready: null }
    globalHolder[KEY] = current
  }
  return current
}

export function database(): Database {
  return holder().db
}

/** Apply the schema, then load the snapshot if the database is still empty. */
export function ensureReady({ seedIfEmpty = true } = {}): Promise<void> {
  const current = holder()
  current.ready ??= (async () => {
    await migrate(current.db, { migrationsFolder: join(process.cwd(), "drizzle") })
    if (!seedIfEmpty) return
    const [row] = await current.db.select({ id: schema.datasetMetadata.id }).from(schema.datasetMetadata).limit(1)
    if (!row) {
      const { seedDataset } = await import("./seed-data")
      console.log("Empty database: loading the fictional snapshot…")
      const summary = await seedDataset(current.db)
      console.log(summary)
    }
  })()
  return current.ready
}

export async function closeDatabase(): Promise<void> {
  const current = globalHolder[KEY]
  if (!current) return
  globalHolder[KEY] = undefined
  await current.client.close()
}

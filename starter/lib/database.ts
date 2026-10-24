// Postgres in process, with PGlite, held in memory. The snapshot is loaded from
// ../dataset/data each time the server starts, so the app runs from a fresh clone
// with nothing but Node and a stopped process can never leave a broken database.
// What people decide is kept separately, in lib/control-room.ts. One instance per
// process: Next can load this module from several bundles, so it lives on globalThis.

import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import * as schema from "./schema"

export type Database = PgliteDatabase<typeof schema>

type Holder = { client: PGlite; db: Database; ready: Promise<void> | null }

const KEY = Symbol.for("control-room.database")
const globalHolder = globalThis as unknown as Record<symbol, Holder | undefined>

function holder(): Holder {
  let current = globalHolder[KEY]
  if (!current) {
    const client = new PGlite()
    current = { client, db: drizzle(client, { schema }), ready: null }
    globalHolder[KEY] = current
  }
  return current
}

export function database(): Database {
  return holder().db
}

/** Apply the schema and load the snapshot, once per process. */
export function ensureReady(): Promise<void> {
  const current = holder()
  current.ready ??= (async () => {
    await migrate(current.db, { migrationsFolder: join(process.cwd(), "drizzle") })
    const { seedDataset } = await import("./seed-data")
    console.log(await seedDataset(current.db))
  })()
  return current.ready
}

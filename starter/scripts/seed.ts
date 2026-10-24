import "dotenv/config"
import { closeDatabase, database, ensureReady } from "../lib/database"
import { seedDataset } from "../lib/seed-data"

// Replaces the snapshot in the local database. Stop `npm run dev` first: PGlite
// allows one process at a time on its data folder. Decisions made in the control
// room are kept.
async function main(): Promise<void> {
  await ensureReady({ seedIfEmpty: false })
  console.log(await seedDataset(database()))
}

main()
  .catch((error: unknown) => { console.error(error); process.exitCode = 1 })
  .finally(closeDatabase)

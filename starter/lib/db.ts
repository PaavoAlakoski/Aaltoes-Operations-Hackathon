import "server-only"

import { database } from "./database"

// Route handlers import `db`. The schema and the snapshot are loaded once at
// server start, in instrumentation.ts.
export const db = database()

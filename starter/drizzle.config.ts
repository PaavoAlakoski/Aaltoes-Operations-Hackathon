import { defineConfig } from "drizzle-kit"

// The app runs Postgres in process with PGlite. `npm run db:generate` writes the
// SQL migrations the app applies on start.
export default defineConfig({
  schema: "./lib/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
})

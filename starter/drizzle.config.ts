import "dotenv/config"
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  // Both files must be listed: `drizzle-kit push` drops tables it does not see.
  schema: ["./lib/schema.ts", "./lib/watch/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://controlroom:controlroom@localhost:5438/controlroom" },
})

// Runs once when the server starts, before it handles a request: apply the
// schema and load the snapshot into an empty database.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return
  const { ensureReady } = await import("./lib/database")
  await ensureReady()
}

import "server-only"

import { ensureAgentService } from "./agent/service"
import { ensureRunner } from "./watch/runner"

// Starts the demo runner and the agent service once per server process. Every route calls it.
export function ensureServices(): void {
  ensureRunner()
  ensureAgentService()
}

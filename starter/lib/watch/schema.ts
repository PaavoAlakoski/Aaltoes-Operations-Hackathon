import { doublePrecision, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core"

// Connection Watch state. These tables never reference the snapshot tables with foreign keys,
// so `npm run db:seed` can replace the snapshot without touching our work.

export type EvidenceRef = { table: string; id: string }
export type HandoverConfig = {
  siteId: string
  siteName: string
  hours: Record<string, string | null> | null
  callAheadMin: number
  afterHoursDrop?: boolean
  accessNote: string | null
  promiseStartAt: string | null
  promiseEndAt: string | null
  promiseRef: EvidenceRef | null
  // Which one the watch deadline is: the end of the promised window, or the site closing first.
  deadlineIs: "PROMISE_END" | "SITE_CLOSE"
  // Set once the promised window has passed without a handover. The site may still be open.
  promiseBrokenAt?: string | null
}
export type LatLng = [number, number]

export const cwSimClock = pgTable("cw_sim_clock", {
  id: text("id").primaryKey(),
  baseRealAt: timestamp("base_real_at", { withTimezone: true }).notNull(),
  baseSimAt: timestamp("base_sim_at", { withTimezone: true }).notNull(),
  speed: doublePrecision("speed").notNull(),
  scenarioId: text("scenario_id"),
})

export const cwWatches = pgTable("cw_watches", {
  id: text("id").primaryKey(),
  assignmentId: text("assignment_id").notNull(),
  orderId: text("order_id").notNull(),
  driverId: text("driver_id"),
  targetKind: text("target_kind").notNull(),
  targetLabel: text("target_label").notNull(),
  targetRef: jsonb("target_ref").$type<EvidenceRef>().notNull(),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
  departureAt: timestamp("departure_at", { withTimezone: true }),
  targetLat: doublePrecision("target_lat").notNull(),
  targetLng: doublePrecision("target_lng").notNull(),
  targetTimezone: text("target_timezone").notNull(),
  routePolyline: jsonb("route_polyline").$type<LatLng[]>().notNull(),
  plannedSpeedKmh: doublePrecision("planned_speed_kmh").notNull(),
  speedSpread: doublePrecision("speed_spread").notNull(),
  planningRef: jsonb("planning_ref").$type<EvidenceRef | null>(),
  reportedDelayMin: integer("reported_delay_min").notNull().default(0),
  state: text("state").notNull(),
  slackMin: integer("slack_min"),
  etaLowAt: timestamp("eta_low_at", { withTimezone: true }),
  etaHighAt: timestamp("eta_high_at", { withTimezone: true }),
  remainingKm: doublePrecision("remaining_km"),
  lastPositionAt: timestamp("last_position_at", { withTimezone: true }),
  lastEvalAt: timestamp("last_eval_at", { withTimezone: true }),
  explanation: jsonb("explanation").$type<string[]>().notNull().default([]),
  madeAt: timestamp("made_at", { withTimezone: true }),
  lastTriggerAt: timestamp("last_trigger_at", { withTimezone: true }),
  // Delivery watches: the receiving site and the customer promise. Null for ferry watches.
  handover: jsonb("handover").$type<HandoverConfig | null>(),
  outlook: jsonb("outlook").$type<unknown>(),
}, (table) => [index("cw_watches_order_idx").on(table.orderId)])

export const cwPositions = pgTable("cw_positions", {
  id: serial("id").primaryKey(),
  assignmentId: text("assignment_id").notNull(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  speedKmh: doublePrecision("speed_kmh"),
  accuracyM: doublePrecision("accuracy_m"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
}, (table) => [index("cw_positions_assignment_idx").on(table.assignmentId, table.observedAt)])

export const cwSlackHistory = pgTable("cw_slack_history", {
  id: serial("id").primaryKey(),
  watchId: text("watch_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  state: text("state").notNull(),
  slackMin: integer("slack_min"),
  etaLowAt: timestamp("eta_low_at", { withTimezone: true }),
  etaHighAt: timestamp("eta_high_at", { withTimezone: true }),
}, (table) => [index("cw_slack_history_watch_idx").on(table.watchId, table.at)])

// A run pauses on wait_for / propose_action / close_run and resumes on the next event.
// `messages` is the model conversation, append-only, stored exactly as the API returned it.
export const cwAgentRuns = pgTable("cw_agent_runs", {
  id: text("id").primaryKey(),
  watchId: text("watch_id"),
  orderId: text("order_id").notNull(),
  trigger: text("trigger").notNull(),
  status: text("status").notNull(),
  outcomeSummary: text("outcome_summary"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  messages: jsonb("messages").$type<unknown[]>().notNull().default([]),
  // tool_use ids left open by the suspending call, filled in when the run wakes.
  suspendedToolUseIds: jsonb("suspended_tool_use_ids").$type<string[]>().notNull().default([]),
  // Results of tools that ran in the same turn as the suspending call, sent with the wake-up.
  pendingToolResults: jsonb("pending_tool_results").$type<unknown[]>().notNull().default([]),
  waitUntil: timestamp("wait_until", { withTimezone: true }),
  waitReason: text("wait_reason"),
  inbox: jsonb("inbox").$type<unknown[]>().notNull().default([]),
  modelCalls: integer("model_calls").notNull().default(0),
  toolCalls: integer("tool_calls").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
}, (table) => [index("cw_agent_runs_order_idx").on(table.orderId)])

// Bookings and approvals the demo made after a person said yes. All mock: nothing real is bought.
export const cwBookings = pgTable("cw_bookings", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull(),
  proposalId: text("proposal_id").notNull(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  reference: text("reference"),
  costCents: integer("cost_cents"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [index("cw_bookings_order_idx").on(table.orderId)])

export const cwAgentSteps = pgTable("cw_agent_steps", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(),
  tool: text("tool"),
  input: jsonb("input").$type<unknown>(),
  output: jsonb("output").$type<unknown>(),
  summary: text("summary"),
  evidenceRefs: jsonb("evidence_refs").$type<EvidenceRef[]>().notNull().default([]),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (table) => [index("cw_agent_steps_run_idx").on(table.runId, table.seq)])

export type ProposalChange = {
  kind: string
  label: string
  sailingId?: string | null
  hotelId?: string | null
  costCents?: number | null
  draftBody?: string | null
  needsApproval: boolean
}

export const cwProposals = pgTable("cw_proposals", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  orderId: text("order_id").notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull(),
  changes: jsonb("changes").$type<ProposalChange[]>().notNull(),
  decideByAt: timestamp("decide_by_at", { withTimezone: true }),
  afterApproval: text("after_approval").notNull(),
  evidenceRefs: jsonb("evidence_refs").$type<EvidenceRef[]>().notNull().default([]),
  status: text("status").notNull(),
  reviewedBy: text("reviewed_by"),
  reviewNote: text("review_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  supersededBy: text("superseded_by"),
}, (table) => [index("cw_proposals_order_idx").on(table.orderId)])

export const cwMessages = pgTable("cw_messages", {
  id: serial("id").primaryKey(),
  orderId: text("order_id").notNull(),
  runId: text("run_id"),
  party: text("party").notNull(),
  direction: text("direction").notNull(),
  body: text("body").notNull(),
  quickReplies: jsonb("quick_replies").$type<string[]>().notNull().default([]),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (table) => [index("cw_messages_order_idx").on(table.orderId, table.at)])

export const cwDrafts = pgTable("cw_drafts", {
  id: serial("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  orderId: text("order_id").notNull(),
  recipient: text("recipient").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
})

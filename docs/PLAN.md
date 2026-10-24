# Connection Watch — architecture and task list

On-the-road agent for the Bahn Control Room challenge. The driver's phone sends
GPS; a deterministic engine keeps the **slack** to the next hard transition
(ferry check-in, train, pickup slot, site closing, delivery window). When slack
gets thin or the signal goes stale, an LLM agent does the legwork (ask driver,
check carrier, find alternatives) and either closes the case quietly or brings
one operator decision to the control room.

---

## 1. Principles

1. **Math is not the model's job.** ETA and slack are a pure function, run on
   every position. The LLM starts only on threshold crossings.
2. **Cheap work first, approval before change.** Read / ask driver / ask carrier
   / ask site are free. Rebooking, costs, date changes and any customer message
   go through `propose_action` and wait for a person.
3. **Customers are unreachable by design.** No tool can message a customer. The
   only path is an approved proposal whose execution creates a *draft* the
   operator sends.
4. **Every fact has a source.** Agent outputs carry `evidence_refs`
   (`{table, id}`); the UI renders them as source chips.
5. **Recheck before write.** Approved actions re-read current state before
   executing (mirrors Bahn's `RECHECK_CURRENT_STATE_BEFORE_WRITE`).
6. **Stale ≠ late.** No position for N minutes is its own state (unknown),
   handled by asking, not alarming.
7. **Snapshot data stays untouched.** Our state lives in our own tables with no
   foreign keys into starter tables, so `npm run db:seed` keeps working.

---

## 2. System overview

```
┌──────────────────────┐   POST /api/positions     ┌────────────────────────────┐
│ Driver PWA           │ ────────────────────────▶ │ Position intake            │
│ /driver/[assignment] │                           │  store watch_positions     │
│  - watchPosition     │ ◀── SSE /api/stream ───── │  → Slack engine (pure fn)  │
│  - or GPS replay     │                           │  → state change? emit      │
│  - one-tap replies   │                           └─────────────┬──────────────┘
└──────────────────────┘                                         │ threshold crossed
          ▲                                                      ▼
          │ driver_messages                       ┌────────────────────────────┐
          │                                       │ Agent runner (Claude loop) │
┌─────────┴────────────┐   message_driver tool    │  tools: read / ask / look  │
│ Simulated driver     │ ◀─────────────────────── │  up / propose / wait       │
│ (LLM + hidden truth) │                          │  writes agent_steps        │
└──────────────────────┘                          └─────────────┬──────────────┘
                                                                │ proposal
                                                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Control room (operators)                                                     │
│  /            connections strip + "needs you" queue (sorted by decide-by)    │
│  /orders/[id] connection timeline, agent steps, sources, decision card, chat │
│  Approve / Change / Reject → executor (recheck → apply → notify driver)      │
└──────────────────────────────────────────────────────────────────────────────┘
          ▲
          │ demo only
┌─────────┴────────────┐
│ Sim control panel    │  sim clock speed, play route, "traffic jam", "phone
│ /sim                 │  dies", "carrier says full", reset scenario
└──────────────────────┘
```

Stack: the existing starter (Next.js 16, TypeScript, Postgres, Drizzle).
Added: Anthropic SDK, Leaflet + OSM tiles (driver map + order map), Zod.
Live updates: Server-Sent Events from a single in-process event bus.

> Starter `AGENTS.md` warns this Next.js has breaking changes — read
> `node_modules/next/dist/docs/` before writing routes.

---

## 3. Data model (new tables, prefix `cw_`)

| Table | Purpose | Key fields |
|---|---|---|
| `cw_sim_clock` | Single row demo clock | `base_real_at`, `base_sim_at` (starts at snapshot `2026-10-21T09:00Z`), `speed` |
| `cw_watches` | One active watch per assignment | `assignment_id`, `order_id`, `target_kind` (FERRY_CHECKIN, TRAIN, PICKUP_SLOT, SITE_CLOSE, DELIVERY_WINDOW), `target_ref {table,id}`, `deadline_at`, `target_lat/lng`, `route_polyline`, `state`, `slack_min`, `slack_low/high`, `last_eval_at` |
| `cw_positions` | GPS points | `assignment_id`, `lat`, `lng`, `speed_kmh`, `accuracy_m`, `observed_at`, `received_at`, `source` (driver_app / replay) |
| `cw_slack_history` | For trend + sparkline | `watch_id`, `at`, `slack_min`, `eta_low`, `eta_high` |
| `cw_agent_runs` | One per trigger | `watch_id`, `order_id`, `trigger`, `status` (running/waiting/escalated/closed), `outcome_summary` |
| `cw_agent_steps` | Visible trace | `run_id`, `seq`, `kind` (thought_summary / tool_call / tool_result / message), `tool`, `input`, `output`, `evidence_refs`, `at` |
| `cw_proposals` | Decisions for people | `run_id`, `order_id`, `title`, `changes[]` (each `{kind, from, to, cost_cents, needs_approval}`), `decide_by_at`, `after_approval` (plain text), `evidence_refs`, `status` (pending/approved/changed/rejected/executed/failed/superseded), `reviewed_by`, `review_note` |
| `cw_messages` | Agent ↔ driver / site / carrier / operator chat | `order_id`, `run_id`, `party` (driver/site/carrier/operator/agent), `body`, `quick_replies[]`, `at` |
| `cw_drafts` | Customer messages awaiting send | `proposal_id`, `recipient`, `body`, `status` |

Snapshot inputs read (never written): `travel_reservations`
(`check_in_cutoff_at`, `departure_at`, `booking_reference`, `amendment_request`),
`travel_options` (alternatives, `status`, `capacity_note`, `quote_cents`),
`terminal_road_estimates` (low/high minutes, `excludes`), `ferry_terminals`,
`transport_segments` / `transport_points`, `time_windows`, `tracking_observations`,
`drivers`, `orders`, `messages`, `alerts`.

Mock world (JSON fixtures in `lib/watch/mock/`): terminal coordinates
(fictional pins in terminal city), carrier sailings + live capacity, hotels near
terminals, route polylines for the demo routes.

---

## 4. Slack engine (`lib/watch/slack.ts`, pure, unit-tested)

```
eta_mid   = now + remaining_km / blended_speed
eta_low/high from terminal_road_estimates ratio applied to remaining distance
buffers   = breaks (15 min / 2 h driving) + handling (10) + check-in walk (10)
            + driver-reported delay
slack     = deadline_at − (eta_high + buffers)        ← pessimistic end
trend     = slope of slack over last 30 sim-minutes
```

- `remaining_km`: distance along `route_polyline` from the nearest point
  (fallback: haversine × 1.3 road factor).
- `blended_speed`: 0.6 × planned (from road estimate) + 0.4 × observed
  rolling average, clamped.
- **States**
  | State | Rule |
  |---|---|
  | `ON_TRACK` 🟢 | slack ≥ 60 min and trend not forecasting < 30 within 1 h |
  | `TIGHTENING` 🟡 | 20 ≤ slack < 60, or trend forecasts < 20 within 1 h |
  | `AT_RISK` 🔴 | slack < 20 |
  | `STALE` ⚪ | no position for > 20 sim-min (uses `observed_at`, not `received_at`) |
  | `MADE` ✅ | within 300 m of terminal pin + driver confirms, or gate event |
  | `MISSED` ⛔ | now > deadline and not MADE |
- **Triggers to agent**: transition into TIGHTENING, AT_RISK or STALE (debounced:
  at most one run per watch per 15 sim-min; an open run receives the update
  instead of starting a new one).
- Each evaluation returns `explanation[]` lines ("1 280 km left · 74 km/h avg ·
  +25 min buffers") so the UI can show how the number was built.

---

## 5. The agent (`lib/agent/`)

Model: `claude-sonnet-5-5` for the ops agent (tool-heavy loop), `claude-haiku-5-5`
for the simulated driver. Loop via Anthropic SDK tool use; each tool call and
result persisted to `cw_agent_steps` and pushed over SSE.

### Tools

| Tool | Class | Notes |
|---|---|---|
| `get_watch_status` | read | slack, ETA range, explanation, trend, freshness |
| `get_order_context` | read | order, car, customer (name only), promise, latest messages |
| `get_travel` | read | booked vs quoted vs amendment-requested, clearly labelled |
| `search_alternatives` | look-up (mock) | later sailings/trains with capacity, price, new delivery ETA |
| `search_hotels` | look-up (mock) | near terminal, price |
| `compute_decide_by` | read | latest time an alternative stays bookable (capacity × cutoff) |
| `message_driver` | ask | text + quick replies; blocked when driver speed > 5 km/h unless quick-reply only |
| `ask_carrier` | ask (mock) | late check-in tolerance, space on later sailing |
| `wait_for` | control | park run until driver reply / position / time; resumes automatically |
| `propose_action` | **gated** | creates `cw_proposals` row; run status → escalated |
| `close_run` | control | outcome summary + evidence; used for quiet closes |

No `message_customer`, `book_*` or `change_date` tool exists. Those are proposal
change kinds, executed only by `lib/agent/executor.ts` after approval.

### System prompt essentials

- Role: Bahn on-the-road agent; goal is the car makes its connection, or the
  operator gets one clear decision early enough to matter.
- Order of work: check freshness → ask driver → check carrier → look up
  alternatives → decide close vs propose.
- Stop rules: propose when a change needs approval, a customer promise is at
  risk, or facts conflict and can't be resolved; close when slack recovers.
- Always cite `evidence_refs`; say "quoted" vs "booked"; never give mechanical
  advice; never contact the customer.
- Output proposals in plain operator language with `after_approval` spelled out.

### Executor (on approval)

1. Recheck: re-run slack engine + re-query alternative capacity.
2. If facts changed → mark proposal `superseded`, start a new run, tell operator.
3. Else apply mock changes (new reservation row in `cw_*`, expense, revised
   ETA), message driver with the new plan, create `cw_drafts` for customer
   update, log steps.

### Operator chat

Free text on the order page appends an `operator` message to the run and
resumes the loop ("no hotel, he can sleep on board" → agent revises proposal,
old one `superseded`, history kept).

### Simulated driver (`lib/agent/sim-driver.ts`)

Separate LLM call per incoming message. Prompt = driver persona from
`drivers.jsonl` + scenario hidden truth (where they are, why slow, battery,
mood) + messiness rules (answer 2 of 3 questions, slight place-name drift,
delay 20–90 sim-sec). Replies arrive as `driver` messages and resume `wait_for`.
Real humans can also reply from the PWA; same path.

---

## 6. Screens

### Driver PWA `/driver/[assignmentId]`
- Big card: next transition, deadline (local tz), ETA range, margin, colour.
- Small map with own position + target pin.
- Message tray: agent questions; quick-reply chips; text input only when stopped.
- Tracking banner: "Location shared for CD-420603 until delivery".
- Plan-changed screen after approval ("New ferry 22:00 · hotel booked · …").
- Manifest + service worker (installable), offline position queue.

### Control room `/`
- **Connections strip**: every active watch as a margin bar, grouped by state;
  "12 on track · 2 tightening · 1 needs you · 1 closed quietly today".
- **Needs you queue**: rows with verb-first decision, decide-by countdown,
  reason, cost. Sorted by `decide_by_at`, then severity.
- **Agent working** (collapsed): runs in progress with current step.
- Calm empty state ("Nothing needs you. Agents are watching 15 connections.").

### Order page `/orders/[id]` (extend starter)
- **Connection timeline**: horizontal now → ETA range → check-in cutoff →
  departure; backup sailing lane underneath; decide-by marker.
- **Slack sparkline** with explanation lines.
- **What happened** (agent summary) + **agent steps** (collapsible, each with
  source chips).
- **Decision card**: changes list (from → to, cost, needs-approval badge),
  after-approval text, Approve / Change / Reject; reject requires a reason.
- **Conversation**: driver / carrier / agent / operator thread, channel labelled.
- Booked / Quoted / Requested badges on all travel.

### Sim panel `/sim` (demo only, hidden from nav)
- Scenario picker, clock speed (1× / 30× / 120×), play / pause, inject: traffic
  jam (speed → 15 km/h for 40 km), phone offline, carrier full on backup,
  reset.

---

## 7. Demo scenarios

| # | Order | Story | Shows |
|---|---|---|---|
| A (main) | **ord-00603** | Booked ferry `WBV-FERRY-00603`; 1 772 km left at snapshot; later crossing already *requested, not confirmed*. Traffic jam → AT_RISK → agent asks driver, asks carrier, finds 22:00 sailing with 2 slots, proposes rebook + hotel, decide-by 16:40 → operator approves → driver phone updates, dealer draft created | full loop, decide-by, approval, draft-not-send |
| B | **ord-00324** | Driver app quiet for 35 min on the E4 → STALE → agent asks driver, positions arrive late with original times, margin fine → closed quietly, no one bothered | knowing when to stop |
| — | ord-00075, 00439, 00584 | Same morning, on track, check in on their own | the quiet volume around the stories |
| C | **ord-00299** | Backup sailing sold out (`travel_options` SOLD_OUT) → agent proposes alternate route / next-day + customer promise change | chained consequences, conflicting facts |

All five run on one demo clock from the snapshot (21 Oct 09:00 UTC): they are the
snapshot's ferry bookings still ahead of check-in that morning. ord-00020 was dropped
from B because it was already delivered on 19 Oct.

Scenario fixtures live in `lib/watch/mock/scenario.ts` (route, hidden driver
truth, scripted injections, expected outcome) and double as e2e tests.

---

## 8. Task list

Estimates assume 2–3 people. **P0 = must ship for the demo.**

### Phase 0 — Setup (Sat morning, ~1 h)
- [ ] P0 Fork repo, run starter from fresh clone, confirm README steps work
- [ ] P0 Create `BUILD-LOG.md`; log prompts, rejections, checks from now on
- [ ] P0 Add deps: `@anthropic-ai/sdk`, `zod`, `leaflet`, `react-leaflet`
- [ ] P0 `.env.example`: `ANTHROPIC_API_KEY`, `SIM_SPEED`
- [ ] P0 Read Next 16 docs in `node_modules/next/dist/docs/` (routes, SSE)

### Phase 1 — Engine, no LLM (Sat, ~4 h)
- [ ] P0 `cw_*` tables in `lib/watch/schema.ts` + `db:push`
- [ ] P0 Sim clock module + `GET/POST /api/sim/clock`
- [ ] P0 Mock world fixtures: terminal pins, sailings with capacity, hotels, 3 route polylines
- [ ] P0 Watch builder: from assignment → next transition target + deadline (ferry first; pickup/delivery windows P1)
- [ ] P0 Slack engine pure function + unit tests (states, stale, trend, explanation)
- [ ] P0 `POST /api/positions` → store → evaluate → persist history → emit event
- [ ] P0 Event bus + `GET /api/stream` (SSE, filter by order / assignment)
- [ ] P0 GPS replay runner (server-side, driven by sim clock) + injections

### Phase 2 — Driver PWA (Sat, ~3 h, parallel to Phase 1 after schema)
- [ ] P0 `/driver/[assignmentId]` big card, live via SSE
- [ ] P0 Real `watchPosition` mode + replay mode toggle
- [ ] P0 Message tray with quick replies; text input disabled while moving
- [ ] P1 Mini map (Leaflet)
- [ ] P1 Manifest + service worker + offline queue
- [ ] P1 Plan-changed screen

### Phase 3 — Agent (Sat evening → Sun morning, ~5 h)
- [ ] P0 Tool definitions + Zod schemas + implementations over snapshot + mocks
- [ ] P0 Agent runner loop, persistence of steps, SSE push
- [ ] P0 `wait_for` / resume on driver reply, position, or time
- [ ] P0 `propose_action` + `close_run`; trigger wiring from slack engine
- [ ] P0 Simulated driver with scenario hidden truth
- [ ] P0 Executor: recheck → apply mock → notify driver → customer draft
- [ ] P1 Operator chat resumes run; supersede old proposal
- [ ] P1 Guard: tool-level enforcement (no customer contact, driver-moving rule)
- [ ] P1 Save full traces to `traces/*.jsonl` for the repo

### Phase 4 — Control room (Sun morning, ~4 h, parallel to Phase 3)
- [ ] P0 Connections strip on `/` replacing lane board as default view
- [ ] P0 Needs-you queue sorted by decide-by, verb-first rows
- [ ] P0 Order page: connection timeline, decision card, agent steps with source chips
- [ ] P0 Approve / Change / Reject flow with clear "what happens next"
- [ ] P1 Slack sparkline + explanation; booked/quoted/requested badges
- [ ] P1 Empty, loading and stale states designed, not default
- [ ] P2 Trust settings (auto-approve expense under €X) — UI + executor check

### Phase 5 — Demo, quality, hand-in (Sun until 14:00)
- [ ] P0 `/sim` panel with scenario A/B/C + injections
- [ ] P0 Run scenarios A, B, C end to end at least 3× each; fix flakiness
- [ ] P0 Scenario tests (engine deterministic; agent run asserts no forbidden tool, proposal created / run closed)
- [ ] P0 README: fresh-clone steps incl. API key, `npm run demo:reset`
- [ ] P0 Record 2–3 min video: problem → driver phone + control room split → approve → quiet close → how we built it with Claude Code (BUILD-LOG highlights)
- [ ] P0 Hub write-up with screenshots, repo + video links; **Submit before 15:00**
- [ ] P1 Visual polish pass (type scale, spacing, colour states in starter palette)

### Cut list if behind (in order)
1. Trust settings  2. Offline queue / service worker  3. Scenario C
4. Operator chat (keep Approve / Reject)  5. Maps (keep timeline)

---

## 9. Ownership suggestion

| Person | Owns |
|---|---|
| A | Slack engine, sim clock, replay, positions API, SSE |
| B | Agent runner, tools, simulated driver, executor, traces |
| C | Driver PWA, control room UI, polish, video |

Integration checkpoints: Sat 18:00 (engine emits states to a bare UI), Sun 10:00
(scenario A end to end), Sun 13:00 (feature freeze, record).

## 10. Risks

| Risk | Mitigation |
|---|---|
| iOS PWA can't track in background | Replay mode is the demo path; say so in the pitch |
| LLM loop flaky in live demo | Deterministic sim seeds, scenario fixtures, recorded fallback video segment |
| Next 16 API surprises | Read bundled docs first; keep SSE in a plain route handler |
| Reseed breaks with our tables | No FKs to starter tables; `cw_` prefix; separate reset script |
| Looks like a dev tool | Agent trace collapsed by default; plain-language labels; no raw JSON in UI |

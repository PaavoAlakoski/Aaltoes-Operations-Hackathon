# Build: Bahn Control Room, v2 (clean rebuild)

You are building an entry for Bahn's "Car Delivery Control Room" challenge (Prompt Operations Hackathon, hand-in Sunday 25 Oct 15:00). Work in a NEW folder, `control-room/`, at the root of this repo.

**Do not copy, import or adapt code from `starter/`.** You may look at `mockups/` for the brand feel. You may read `starter/app/globals.css` only to confirm the colour values listed below.

## 1. Read first, before any code
- `PARTICIPANT-BRIEF.md`: what to build and how it is judged (control room 40%, how we worked with AI 30%, taste 30%).
- `OPERATIONS-CONTEXT.md`
- `dataset/README.md` and `dataset/SCHEMA.md`: every evidence rule below comes from these.
- `BUILD-LOG.md`: what v1 learned. Keep appending to it as you work: what you asked, what you checked, what you threw away.

Then write a short plan, and ask me before starting if anything is unclear.

## 2. Product in one paragraph
Operations staff open the app and see only the orders that need a person, ranked by risk and by the clock that decides them. Opening one shows a single decision: what happened, what an agent found or proposes, the evidence, and exactly what happens if they approve, change or reject it. Everything else stays out of the way. Agents do the legwork; people make the judgement calls.

There is no agent in this build. Design the data and the screens so an agent's proposals (later via OpenRouter) land in the same review flow.

## 3. Stack
- Vite + React 19 + TypeScript (strict). React Router for routes. No UI kit. Plain CSS with custom properties, one `tokens.css`, CSS modules per component.
- A hosted Supabase project; env in `control-room/.env`:
  - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` for the app
  - `SUPABASE_SERVICE_ROLE_KEY` for the seed script only, never shipped to the browser
- Commit `.env.example`, never `.env`.
- Tests: Vitest for the domain logic, one Playwright smoke test for the main flow.

### Database (SQL migrations in `control-room/supabase/migrations/`)
- `records(collection text, id text, order_id text null, data jsonb, primary key (collection, id))`: every JSONL row from `dataset/data/*.jsonl`, unchanged. The snapshot is read-only.
- `decisions(id uuid, order_id text, target_type text, target_id text, action text, note text, decided_by text, decided_at timestamptz, effects jsonb)`
- `autonomy(action_kind text primary key, level text, updated_at timestamptz)`
- RLS:
  - anon may `select` all three tables
  - anon may not insert, update or delete anything directly
- Writes go only through `security definer` RPCs:
  - `decide(order_id, target_id, action, note)`
  - `undo_decision(id)`
  - `set_autonomy(kind, level)`
- `decide` re-reads current state and rejects a decision on an item that is already decided, with a clear error (stale-state protection). It also enforces that a note is given for change, reject and done.
- `scripts/seed.ts` (Node, service-role key):
  - loads every collection
  - checks row counts against `dataset/data/manifest.json`
  - is idempotent (upsert)
  - prints a one-line summary
- Attachments: upload `attachments/` to a public Supabase Storage bucket in the seed. Verify each file's SHA-256 against `attachments/manifest.json` before uploading.
  - Add `.gitattributes` so the packet's files are never line-ending-converted: `attachments/** -text`, `dataset/** -text`, `*.pdf binary`, `*.jpg binary`.
  - v1 lost hashes to `core.autocrlf` on Windows.

### Domain logic (pure TypeScript, `src/domain/`, unit tested)
- Load all rows once (paginate past Supabase's 1000-row limit) into an in-memory index by order.
- All derivation lives here, not in components:
  - **attention**: what needs a person on an order
  - **triage**: ranking and groups
  - **case view**: the decision cards, facts and timeline
- The clock: the dataset is a frozen snapshot at `manifest.snapshot_at`. Every relative time ("in 2 h", "3 h ago") is measured against it, never against the real clock.

## 4. Evidence rules the UI must respect (from SCHEMA.md)
- A quote (`travel_options`) is not a booking (`travel_reservations`), and a booking is not a boarding.
- An alert is a signal, not a diagnosis. ACKNOWLEDGED is not resolved.
- A message is a claim by its speaker at its time, not a verified fact.
- `CONFIRMED` from `MANAGED_SITE_PROFILE` is the standard site profile, not a call about this car. Show it as **Stated**, not Confirmed.
- A digital CMR (the transport document) marked SIGNED with `signature_scope: COLLECTION_ONLY` was signed at pickup, not by the receiver.
- Support inbox `candidate_order_ids` are guesses. Only `linked_order_ids` are links.
- Agent proposal text proves nothing changed. Only a linked effect event does.
- `display_lane` is a convenience, not truth. Derive stage from status, offers and assignments.
- A quiet order is not a verified order. Say so where it matters.
- Every fact shown carries a certainty: **Confirmed / Stated / Planned / Quote / Missing**, plus who said it and when.

## 5. What needs a person (attention)
Derive items per order from:
- open and acknowledged alerts
- unresolved incidents
- open work items (they have `next_action` and `due_at`)
- open conversations (with `waiting_on` and `next_check_at` when present)
- agent proposals: PENDING_REVIEW, APPROVED_AWAITING_EXECUTION or FAILED
- open endpoint claims
- custody assets with a `next_action`
- support inbox threads naming the order
- a booked car whose pickup contact or access is unverified
- a moving car whose driver started and the app has sent no position while the promise is open

A conversation filed on one order and related to another counts for both.

Each item has a **next step** and where it came from, in this order of preference:
1. **record**: the item's own `next_action`
2. **agent**: a pending proposal on the order
3. **playbook**: a short per-signal default you write, labelled "playbook" so nobody mistakes it for a recorded instruction

Never invent text that looks like a record.

## 6. Rules for agents and decisions
- An agent never contacts a customer (anyone who pays). Anything for a customer is drafted, and a person sends it. Turn payloads like `contact: ["site","customer"]` into "Ask the site" (agent) plus "Draft for the customer: you send it" (person). v1 got this wrong once.
- Reading and asking drivers or sites need no approval. Bookings, dates, costs and customer messages start at "ask first".
- Actions per item:
  - proposals: Approve / Change (note) / Reject (note)
  - failed proposals: Retry / I'll handle it / Already sorted (note)
  - everything else: I'll take it / Mark handled (note)
  - inbox candidates: It's this order / Not this one. Linking one rules out the others.
- **Before saving, every action shows what will happen as a numbered list.** Steps still on the person are marked. After saving, the item leaves the queue and shows "Decided by you" with the same list and an **Undo**.
- Proposals with `execution_policy: RECHECK_CURRENT_STATE_BEFORE_WRITE` say "re-checks the order before acting".

## 7. Screens (four, nothing more)
1. **Needs you** (`/`, home)
   - one ranked list in three groups: Decide now, Follow up, Waiting on others
   - the quiet orders collapse to one sentence with a link to the full list
   - filter by desk (owner) and search
   - `j`/`k` to move, `Enter` to open, `/` to search
   - a short "Decided this shift" list at the bottom
2. **Order** (`/orders/:ref`, by reference such as CD-420593)
   - header: car, reference, route, customer, the deciding date
   - one plain-language headline
   - **one lead decision in full**: the agent's proposal when there is one, otherwise the most urgent item
   - every other open item as a single folded line that expands in place
   - right column: the facts with certainty and source
   - below: one timeline of messages, agent work, decisions and events, newest first, filterable by who
   - raw records behind a single "All records" disclosure
3. **Inbox** (`/inbox`): unmatched support messages and the candidate-matching decision.
4. **What agents may do** (`/agents`)
   - each agent's record (proposed, approved, changed, rejected, failed, waiting)
   - an autonomy level per action kind: Ask first / Act then tell / On its own
   - the two fixed rules shown as locked

Also a plain **All orders** table (`/orders`): sortable, by stage, no lanes.

## 8. Visual direction: much cleaner than v1
Brand (Bahn):
- birch `#fffef7` (background), asphalt `#12110e` (text, primary button), sand `#ccc6ba` and `#e6e1d6` (lines), warm grey `#726958` (secondary text)
- status only: red `#b42c42`, orange `#b04617`, teal `#1f6f7b` (agent), green `#1b7a52` (confirmed)
- fonts: Unbounded (page titles only), Poppins (everything else), Reddit Mono (references only), from Google Fonts

Rules:
- **One idea per screen**, readable in five seconds. If a screen needs explaining, cut something.
- Spacing on a 4/8 px grid. Content width 960 px for lists, 1200 px for the order page. 16 px side gutter on phones, no horizontal scroll.
- **Three text sizes per screen at most** (title, body 14–15 px, meta 12–13 px). Two weights (400, 600).
- **Colour means status and nothing else.** Rows are neutral. Status shows as a 6 px dot or a coloured word, never a coloured background block. At most one coloured element per row.
- No cards inside cards, no shadows except one subtle one for the lead decision and popovers. Hairline dividers between rows instead of boxes around everything.
- No chip soup. A row shows at most: car + reference, one reason line, one next-step line, the clock, the owner. Everything else is on the order page.
- Buttons: one primary (asphalt) per decision; secondary actions are plain text buttons.
- Icons: a small consistent stroke set, only where they replace a word.
- Every screen has designed loading (skeleton rows of the real shape), empty ("Nothing needs you right now") and error states.
- Plain operations language. Never show a raw code like `PENDING_REVIEW`: map every code to words in one `labels.ts`.
- Respect `prefers-reduced-motion`. Focus rings visible. Everything usable by keyboard.

## 9. Done means
- `control-room/README.md`: create the Supabase project, run migrations (`supabase db push` or paste the SQL), `npm ci`, `npm run seed`, `npm run dev`. It runs from a fresh clone.
- Vitest covers:
  - triage groups and ordering
  - the evidence rules in section 4
  - the customer rule
  - next-step sourcing
- The Playwright smoke test:
  - opens the queue
  - opens CD-420593
  - approves the proposal and sees the numbered outcome
  - finds it in "Decided this shift"
  - undoes it
  - checks a second decision on the same item is refused
- Walk these orders at 1440 px and 390 px and fix what looks wrong:
  - CD-420299: failed agent booking and ferry sold out
  - CD-420593: empty pickup
  - CD-420322: vehicle warning, the brief's breakdown example
  - CD-420702: delivery promise at risk
  - CD-420455: condition claim with photos
  - CD-420384: keys follow-up
  - one quiet order
  - the inbox thread with two candidates
- `BUILD-LOG.md` updated with what you tried, checked and threw away.
- Commit in small steps on a branch. Do not push unless I ask.

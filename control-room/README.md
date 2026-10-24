# Bahn control room

Operations staff see only the orders that need a person, ranked by risk and
by the clock that decides them. Opening one shows a single decision: what
happened, what an agent found or proposes, the evidence, and exactly what
happens if you approve, change or reject it. Agents do the legwork; people
make the judgement calls.

There is no live agent in this build. Agent proposals from the packet land
in the same review flow a future agent (via OpenRouter) will use: a proposal
is a row with a target, a payload, evidence and a state dependency, and a
person's decision goes through the same `decide()` call.

## Run it from a fresh clone

You need Node 20 or newer and a Supabase project (the free tier is fine).

1. **Create a Supabase project** at supabase.com. Under *Project settings → API keys*,
   copy the project URL, the publishable (anon) key and the secret (service-role) key.

2. **Set the environment.**

   ```sh
   cd control-room
   cp .env.example .env   # then fill in the three values
   ```

   `SUPABASE_SERVICE_ROLE_KEY` is read only by the seed script. It never reaches the browser.

3. **Create the schema.** Either link the project and push:

   ```sh
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

   or paste each file in `supabase/migrations/` into the SQL editor, in name order.

4. **Install and load the data.**

   ```sh
   npm ci
   npm run seed
   ```

   The seed loads every row of `../dataset/data/*.jsonl` into `records`
   unchanged. It checks the row counts against the dataset manifest and each
   attachment's SHA-256 before uploading the attachments to a public
   `packet` bucket. It is safe to run again, and ends with a one-line summary.

5. **Start it.**

   ```sh
   npm run dev
   ```

   Open http://localhost:5173.

## Check it

| Command | What it checks |
| --- | --- |
| `npm test` | Domain logic (Vitest): triage groups and ordering, the evidence rules, the customer rule, next-step sourcing. Reads the packet from disk, no network. |
| `npm run check:db` | The write rules against your project, with the browser's key: the anonymous key can read but not write, `decide()` needs a note where required and refuses a second decision, the customer rule cannot be unlocked, undo works. |
| `npm run test:e2e` | Playwright smoke test: open the queue, open CD-420593, approve, see the numbered outcome, find it under *Decided this shift*, see a second decision refused (409), undo. Plus the keyboard, and a decision made outside the page appearing (and undone) without a reload. Starts the dev server if it is not running. Uses installed Google Chrome; without it run `npx playwright install chromium` and set `PW_CHANNEL=chromium`. |
| `npm run screens -- <folder>` | With the dev server running, screenshots every screen and the brief's named orders at 1440 px and 390 px, and fails on horizontal overflow. |
| `npm run typecheck` | Strict TypeScript. |

## How it is built

- **The snapshot is read-only.** `records(collection, id, order_id, data)` holds every packet row
  as it was. The app loads it once (paginated past the 1000-row limit) and builds an in-memory
  index by order (`src/domain/world.ts`).
- **It stays live.** After the first load, changes to `decisions`, `autonomy` and `records`
  stream in through Supabase Realtime (`src/data/live.ts`). A decision someone else makes, or
  a proposal an agent writes, shows without a reload. A burst of record changes (a re-seed) is
  folded into one rebuild. After a dropped connection the app re-reads decisions and autonomy.
  The header says *Live*, *Connecting…* or *Not live*.
- **The clock is frozen.** Every "in 2 h" and "3 h ago" is measured from `manifest.snapshot_at`,
  never the real clock (`src/domain/clock.ts`).
- **All derivation lives in `src/domain/`**, as pure functions with tests. Components only display:
  - `attention.ts`: what needs a person on an order.
  - `triage.ts`: groups and ranking.
  - `caseView.ts`: the lead decision, folded items, facts and timeline.
  - `evidence.ts`: certainty for each fact.
  - `proposals.ts`: payload to steps, with the customer rule.
  - `outcomes.ts`: the numbered "what will happen" lists.
  - `labels.ts`: plain words for every code.
- **Writes go through three `security definer` functions only:** `decide`, `undo_decision`
  and `set_autonomy`. Row-level security lets the anonymous key read all three tables and write
  none of them. `decide` works out what the item is from the snapshot, not from the caller, and
  refuses a settled proposal or an item that already has a live decision. Conflicts are HTTP 409.
- **Evidence rules** (from `dataset/SCHEMA.md`):
  - A quote is not a booking, and a booking is not a boarding.
  - An acknowledged alert is still open.
  - A message is a claim by its speaker.
  - `CONFIRMED` from the standard site profile shows as **Stated**.
  - A `COLLECTION_ONLY` CMR was signed at pickup, not by the receiver.
  - Inbox candidates are guesses.
  - Only a recorded effect event counts as a change.
  - Stage is derived from status, offers and assignments; `display_lane` is never read.
- **The customer rule:** an agent never contacts anyone who pays. A payload like
  `contact: ["site", "customer"]` becomes "Asks the site…" for the agent and
  "Draft for the customer… You send it." for a person.
- **Next steps** come from the record first, then a pending agent proposal, then a short
  playbook we wrote. A playbook line is always labelled "playbook".

## Screens

- **Needs you** (`/`): Decide now, Follow up, Waiting on others. Search, desk filter,
  `j`/`k`/`Enter` and `/`. Quiet orders collapse to one sentence. *Decided this shift* has undo.
- **Order** (`/orders/CD-420593`): one lead decision in full, every other open item folded to a
  line, facts with certainty and source, a timeline filterable by who, and every raw record
  behind *All records*.
- **Inbox** (`/inbox`): unmatched support messages and the candidate-matching decision.
  Linking one order rules out the others.
- **Agents** (`/agents`): each agent's record, and an autonomy level per kind of action.
  The two fixed rules are locked.
- **All orders** (`/orders`): a plain sortable table, filterable by stage.

How it was built, and what was thrown away along the way: [`../BUILD-LOG.md`](../BUILD-LOG.md).

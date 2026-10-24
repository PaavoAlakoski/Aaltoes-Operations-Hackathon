# The Car Delivery Control Room

Our entry for Bahn's challenge at the Prompt Operations Hackathon, 24 to 25
October 2026. Hand-in is Sunday 25 October, 15:00. The challenge brief is in
`PARTICIPANT-BRIEF.md`.

Live: https://aaltoes-operations-hackathon-starte-tau.vercel.app/

Everything in this repo is made up. No real people, cars, companies or
messages, and nothing in the app contacts anyone.

## The problem

Bahn delivers used cars for dealers. A freelance driver collects each car from
the seller and drives it, often across a border and onto a ferry, to the
dealer. About 50 people in operations run over 25,000 deliveries a year by
phone, email and paperwork. Things go wrong every hour (a missed train, a car
that is not ready, a sold-out ferry, a missing document) and each one starts a
chain that someone has to hold in their head. `OPERATIONS-CONTEXT.md` describes
how the work actually goes.

## What we are building

A control room where people and agents work together to get every car
delivered:

- It shows a person **only the orders that need them**, ranked by risk and by
  the clock that decides them, and says why. Of 100 orders, about 43 need
  someone; the rest stay out of the way.
- Opening an order brings it down to **one decision**: what happened, what an
  agent found or proposes, the evidence behind it, and exactly what happens if
  you approve, change or reject it. Every decision can be undone.
- **Agents do the legwork, people make the judgement calls.** How much each
  agent may do on its own is set per kind of action. Two rules are fixed:
  looking things up and asking drivers or sites needs no approval, and an agent
  never contacts a customer.

Judging (from the brief): the control room itself 40%, how we worked with AI
30%, taste 30%. `BUILD-LOG.md` is our record for the middle one; keep appending
to it.

### In scope

- The control room web app (v2, deployed): queue, order page, inbox, agents
  and autonomy, all orders. Described in detail in
  `apps/control-room/README.md`.
- A shared Supabase backend: the read-only packet snapshot plus decisions, and
  a live operations schema for a driver app and a helper agent (see below).
- Next, being built: a driver app (`apps/driver`), shared code
  (`packages/shared`) and a simulator that drives cars along corridors
  (`tools/simulator`).

### Out of scope

- Contacting anyone for real (email, SMS, phone). Outgoing messages are drafts
  or rows in the database.
- Real booking, payment or ferry integrations.
- Real customer data. The packet in `dataset/` and `attachments/` is the only
  source.

## Repo layout

| Path | What it is |
| --- | --- |
| `apps/control-room/` | The control room (v2): Vite, React 19, strict TypeScript, React Router, plain CSS, Supabase. This is what is deployed. |
| `apps/driver/`, `packages/`, `tools/` | Planned workspaces (driver app, shared code, simulator). |
| `supabase/migrations/` | All SQL migrations, applied in name order to one hosted project. |
| `dataset/` | The packet: 100 made-up orders and everything around them, as JSONL. `dataset/SCHEMA.md` explains every field and the evidence rules. |
| `attachments/` | Made-up documents, receipts and photos, with SHA-256s in `attachments/manifest.json`. |
| `starter/` | v1: Bahn's Next.js starter that we extended first. Kept for reference only; v2 does not import from it. |
| `mockups/` | Screenshots of the original starter, for the brand feel. |
| `BUILD-LOG.md` | How we worked with Claude Code: what we asked, checked and threw away. |
| `REBUILD-PROMPT.md` | The prompt that specified the v2 rebuild. The clearest statement of the product rules. |
| `check_packet.py` | Checks the packet itself. |

The repo is being moved from a single `control-room/` folder to an npm
workspaces monorepo (root `package.json`: `apps/*`, `packages/*`, `tools/*`).
Until that move is committed, the deployed code lives in `control-room/` and
`vercel.json` points there. When moving files, keep `src/` inside the app
folder and update the `root` in `vercel.json` in the same commit.

## Backend

One hosted Supabase project (ref `vtwvdnprbricautvphic`, also in `.mcp.json`).
There is no local Docker or Supabase CLI on the main dev machine: write
migrations as files in `supabase/migrations/` and verify against the remote.

**The snapshot and decisions** (serve the live app; do not drop or alter
without explicit agreement):

- `records(collection, id, order_id, data)`: every packet row, unchanged and
  read-only.
- `decisions`, `autonomy`: what people decided and how much agents may do.
- Writes only through `security definer` functions `decide`, `undo_decision`
  and `set_autonomy`. The anonymous key can read and never write. A second
  decision on the same item is refused with HTTP 409.
- Changes stream to the app through Supabase Realtime.

**The live operations schema** (`20261024160000_ops_schema.sql`, additive):
shared by the control room, the driver app and the helper agent. Vocabulary:

- A **corridor** is a route cars are driven along (a generic brief's "line").
- A **vehicle** is the car being delivered, not a company van. Its id is the
  dataset's car id (`veh-00004`) and it links to the order (`ord-00004`,
  `CD-420004`).
- An **assignment** puts a driver on one car for a shift.
- `profiles` carry a role: `driver`, `dispatcher` or `supervisor`. RLS reads it
  from JWT claims set by `custom_access_token_hook`.
- `incidents` (reported by a driver, control, an agent or the system),
  `messages` (to exactly one user, vehicle or corridor),
  `agent_suggestions` (pending until a person approves or rejects them) and an
  append-only `audit_log`.

## Rules every change must keep

These come from `dataset/SCHEMA.md` and the brief. Breaking one is a bug.

- **The clock is frozen** at `dataset/data/manifest.json`'s `snapshot_at`.
  Every "in 2 h" or "3 h ago" is measured from it, never from the real clock.
- **Evidence:** a quote is not a booking, and a booking is not a boarding. An
  acknowledged alert is still open. A message is a claim by its speaker.
  Inbox candidates are guesses until a person links one. Only a recorded
  effect event counts as a change. Stage is derived from status, offers and
  assignments; `display_lane` is never read.
- **The customer rule:** an agent never contacts anyone who pays. A person may
  send a draft the agent wrote.
- **Derivation lives in `src/domain/`** as pure, tested functions. Components
  only display.
- **Nothing is invented.** A next step comes from the record, then an agent
  proposal, then our playbook, and says which.
- Secrets stay in `.env` (git-ignored). The service-role key is used only by
  the seed script and never reaches the browser.
- `.gitattributes` keeps `dataset/` and `attachments/` byte-exact. Do not let
  line endings be converted; the seed checks every hash.

## Run and check it

Setup, seeding and every check (`npm test`, `npm run check:db`,
`npm run test:e2e`, `npm run screens`, `npm run typecheck`) are in
`apps/control-room/README.md`. In short, with a filled-in `.env`:

```sh
npm ci
npm run seed
npm run dev     # http://localhost:5173
```

Run the domain tests and typecheck before every commit. Run the e2e test
before anything that touches the queue, the order page or `decide()`.

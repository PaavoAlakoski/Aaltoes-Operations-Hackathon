# The Car Delivery Control Room

Our entry for Bahn's challenge at the Prompt Operations Hackathon, 24 to 25
October 2026. The challenge brief is in `PARTICIPANT-BRIEF.md`.

The control room is where people and agents work together to get every car
delivered. It shows a person only the orders that need them, says why, and
brings each one down to a single decision with the evidence behind it. The
other 57 of the 100 orders stay out of the way.

Everything in this repo is made up. No real people, cars, companies or
messages, and nothing in the app contacts anyone.

## Run it

You need Node.js 24 or newer. Docker is not needed: Postgres runs inside the
app, with PGlite.

```sh
cd starter
npm ci
npm run dev
```

Then open http://localhost:3000. On start the app loads the snapshot from
`dataset/data` into memory, which takes a couple of seconds.

Decisions you make are kept in `starter/.data/control-room.json`, so they
survive a restart. Delete that file to start the shift again.

## What is in it

- **Needs you** (`/`). Every order that is waiting on a person, ranked by risk
  and then by the clock that decides it. Orders are grouped into "Decide now",
  "Follow up" and "Waiting on others", and you can filter them by desk. Each row
  says what is wrong, the next step and where that step came from: a record,
  an agent or the playbook. Use `j` and `k` to move, `Enter` to open and `/` to
  search.
- **An order** (`/orders/:id`). One decision is shown in full, usually the
  agent's proposal, and everything else open on the order is folded into one
  line each. Every choice (approve, change, reject, take over, mark handled)
  shows what will happen before anything is saved, and can be undone. Next to
  it are the facts the decision rests on. Each is marked Confirmed, Stated,
  Planned, Quote or Missing, with who said so. Below is one timeline of
  messages, agent work, decisions and recorded events.
- **Inbox** (`/inbox`). Messages that arrived before anyone knew which order
  they belong to. The candidate orders are guesses until a person links one.
- **What agents may do** (`/agents`). Each agent's record, meaning what it
  proposed and what people did with it, and how much it may do on its own for
  each kind of action. Two rules cannot be changed: looking things up and
  asking drivers or sites needs no approval, and an agent never contacts a
  customer.
- **All orders** (`/orders`). The starter's lane board, kept for checking
  volume.

## Check it

With the app running:

```sh
cd starter
npm run typecheck
npm run smoke                 # board and record agree on every order
npm run smoke:control-room    # queue and case agree; decide, refuse a stale decision, undo; no agent step reaches a customer
npm run attachments:smoke     # sample files are served byte-exact
python3 ../check_packet.py    # the packet itself
```

## How we built it

`BUILD-LOG.md` records how we worked with Claude Code: what we asked for, what
we checked, what we threw away and why.

## The packet

- `PARTICIPANT-BRIEF.md`, `OPERATIONS-CONTEXT.md`: the challenge and how the work goes.
- `dataset/`: 100 made-up orders and everything around them. `dataset/SCHEMA.md` explains every field.
- `attachments/`: made-up documents, receipts and photos.
- `starter/`: the app.
- `mockups/`: screenshots of the original starter.

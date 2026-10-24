# Build log

How we built the control room with Claude Code: what we asked for, what we
checked, what we threw away, and where we did not take the first answer.
Newest at the bottom.

## Saturday 24 October

### Reading before building
- We had Claude Code read the brief, `OPERATIONS-CONTEXT.md`, `dataset/README.md`,
  `dataset/SCHEMA.md` and the starter before any code. Its summary of the
  evidence traps (a quote is not a booking, an acknowledged alert is not
  resolved, a signed CMR is signed at collection only, inbox candidates are guesses)
  became a checklist for the UI.
- We asked for a plan first, in plan mode. We decided: **control room only for
  now, the agent later, on OpenRouter**. That's why the decision and
  approval plumbing is built so an agent's proposals land in the same review.

### Infrastructure: three tries
1. The starter needs Docker for Postgres and an S3 store. This machine has
   neither, and a judge's laptop may not either. **Rejected:** "just install Docker".
2. We switched to PGlite (Postgres compiled to WebAssembly) with an on-disk data
   folder. It worked, until the dev server was killed and the data folder came
   back corrupted (`RuntimeError: Aborted()`). **Thrown away.**
3. Final: PGlite **in memory**, loaded from the dataset on every start (about
   2 seconds). The only state people create, their decisions, is kept apart in a
   small JSON file written atomically. A crash can't break it, and the
   snapshot can never be modified by the app.

Attachments are served straight from `attachments/` and checked against the
manifest hash on every read. That check caught a real bug: Git's `core.autocrlf`
had rewritten line endings inside PDFs on this Windows clone. We added
`.gitattributes` so the packet stays byte-exact on any clone.

### The queue: why not lanes
- The starter's home is a board of seven lanes. The brief says that is how
  people worked, "not the answer". We kept it as "All orders" for volume and
  made the home a single ranked list, **Needs you**.
- Before designing it we had Claude Code dump every attention item across all
  100 orders (kind × tone × owner). That showed 43 orders need a person, 39 of
  the items are plain open threads, and most items have no owner. The design
  came from that data:
  - Orders are grouped into **Decide now** (risk, or an agent waiting for a yes),
    **Follow up** and **Waiting on others**.
  - Within a group, risk comes first, then the clock that decides the next step.
  - The 57 quiet orders collapse to one line.
- We dropped a fourth group from the plan, "Agents are on it". With real data it
  was nearly empty and split the agent's work away from the order it belongs to.
  Agent state is a tag on the row instead ("Operations copilot: waiting for your
  yes").
- **Where a next step comes from is always shown.** Many alerts carry no
  recorded next action. Rather than let the model invent one that looks like a
  record, we wrote a short per-signal playbook and label it "playbook", apart
  from "from the record" and "agent".

### The order page: the first version was too loud
- The first build showed every open item as a full card. On CD-420593 (empty
  pickup) that meant five cards that all said "review the agent's proposal".
  It felt busy in the screenshot, so we changed it:
  - **One lead decision is shown in full.** That's the agent's proposal when
    there is one, because it usually answers the rest.
  - The other items fold to one line each.
  - A next step shared by several items is said once.
- **Every action shows what will happen before it is saved**, as a numbered list.
  Steps that remain the person's job are in orange. Every decision can be undone.
- Facts carry a certainty: Confirmed, Stated, Planned, Quote or Missing, plus
  who said so. One rule came from `SCHEMA.md`: a "confirmed" access from the
  standard site profile is shown as **Stated**, because it is not a call about
  this car.

### A rule we caught ourselves breaking
- Proposal payloads like `contact: ["site", "customer"]` were first rendered as
  the agent step "Contact site and customer". That reads as the agent
  contacting a customer, which the rules forbid.
- Now the agent only "asks the site", and the customer part becomes "drafted for
  you, nothing reaches them until you send it".
- We added a check to `npm run smoke:control-room` that fails if any agent step
  mentions a customer without handing it to a person.

### How we checked
- We drove a real Chrome through the flows with `puppeteer-core`:
  - open an order, approve, see the outcome, see it in "Decided this shift", undo
  - link an inbox message and watch the other candidate leave the queue
- Screenshots at 1440 px and 390 px, checking for horizontal overflow (none).
  Two squeezes found at phone width were fixed.
- `smoke:control-room` checks three things:
  - the queue and every order's case agree on all 100 orders
  - a second decision on a decided item is refused (409)
  - undo restores the item
- We re-ran the starter's own smoke tests, which still pass, and changed one
  alert in a copy of the dataset to confirm the queue moves (CD-420702 went
  from "Decide now" to "Follow up").

## Saturday 24 October, afternoon: v2, a clean rebuild

v1 worked, but it grew out of the starter and looked like it. We wrote a
rebuild brief (`REBUILD-PROMPT.md`) and had Claude Code start again in a new
folder, `control-room/`. It was told not to copy anything from `starter/`.
The stack is Vite, React 19, strict TypeScript and plain CSS, on a hosted
Supabase project.

### Reading and asking first
- The brief told it to read the packet docs and write a plan before any code.
  It came back with three questions instead of guessing:
  - which branch to use (a new `control-room-v2`, so v1 stays intact)
  - whether to rename the env vars to the brief's names (yes)
  - whether it may write to the hosted project (yes)
- Before designing anything it profiled every collection: every field, and
  every status value with its count. The attention rules came from those
  counts, not from the brief's wording alone.

### What we checked, and what changed because of it
- **Stage without `display_lane`.** The derived stage matches `display_lane`
  on all 100 orders without ever reading it. A test sets every
  `display_lane` to "delivered" and checks the queue does not change.
- **Pickup checks were too noisy.** The first rule raised "pickup contact or
  access not checked" for every booked order, including pickups six days
  out. The dataset README says a check is due when the slot is near. We
  dropped that first rule and now raise it only within 72 hours of the slot.
- **The wrong clock.** CD-420603 (ferry connection at risk) sat in Follow up
  because its delivery promise was two days away. The ferry check-in closes
  in three hours. A booked crossing still ahead is now the deciding clock.
  The Decide now window went from 2 h to 4 h after we looked at which orders
  actually landed there.
- **Lead decision vs situation.** CD-420322 (the brief's breakdown example)
  first led with the bare alert and a playbook line. The real decision is the
  recovery follow-up, which has a recorded next step: get the owner's
  service decision. Rows now say what happened (the situation), and the order
  page leads with the item that carries the decision. CD-420593's row reads
  "Driver found no car at pickup", not "Operations copilot needs your yes".

### Bugs found by checking, not by reading the code
- **A refused decision hung instead of failing.** `decide()` raised the
  conflict with Postgres error 40001, "serialization failure". The client
  retried it as a transient error, so the call hung. A retry also slipped
  through after we cleared the first decision, which left a stray live
  decision. Conflicts now use PostgREST's `PT409`, a plain HTTP 409.
  `npm run check:db` undoes leftovers before it runs, so it is safe to repeat.
- **A decision leaked into the next item.** The Playwright smoke test caught
  this one. After approving on CD-420593, the alert slid into the lead spot
  still showing "If you approve… Save: Approve". The decision controls are
  now keyed by item. The item you just decided stays in place with "Decided
  by you" and Undo until you leave the order.
- **A false positive in the customer rule.** The rule catches agent steps
  that mention a customer, buyer, dealer or owner. It flagged the approved
  message to the CD-420322 driver, because the quoted text mentions "the
  owner's service instruction". The check now ignores quoted text: the
  quote is what the agent says to the driver, and the words outside it say
  who it is sent to.

### The walkthrough at 1440 px and 390 px
`npm run screens` photographs the named orders at both widths and fails on
horizontal overflow. Looking at the pictures found:
- **CD-420455:** the trade-in's pickup slot was shown as the main car's. Slots
  and promises are now matched to the order's endpoint points everywhere.
- **CD-420702:** our first fix for that was itself wrong. It labelled the
  relay's transfer-yard slot "Trade-in pickup slot". The label now comes from
  the route point: "Yard release slot".
- **CD-420299:** a pickup two days away showed a red "Missing". It now shows
  "Planned" until the slot has passed.
- **CD-420455:** the condition claim's photos were buried in the facts
  column. The lead now shows them, with a caption that a photo shows what was
  submitted, not when the mark was made.
- **Agents page:** "waiting" counted approved-but-not-done proposals as well.
- **Inbox:** each candidate had its own black primary button, two per message.
- **Phones:**
  - On the order page, the facts came after the whole timeline. Grid areas
    now put them between the decision and the history.
  - The nav wrapped onto a second line.

### What we left alone, on purpose
- **CD-420075 is quiet, but its ferry check-in closes in 3 h** and the last
  position says 13% of the way. A person sees that in the header clock, but no
  rule flags it. We kept the attention rules to the brief rather than invent
  a risk model. This is the check the future agent should do first:
  - read the road estimate to the terminal
  - ask the driver
  - only then bring a person a decision
- **No sign-in.** `decided_by` is a fixed "Shift operator".
- **One leftover from testing.** The migration applied to the hosted project
  that moved conflicts to HTTP 409 also marked one leftover test decision
  undone. The migration file in the repo does not include that cleanup.

### Making it live
- **Asked:** does the app update when the database changes? It didn't. It
  loaded once, and other people's decisions only showed after a reload.
- **Built:**
  - `decisions`, `autonomy` and `records` are now in Supabase's realtime
    publication.
  - The store applies each change through small pure functions in
    `src/data/live.ts`, which have tests.
  - Our own save now arrives twice, from the call's reply and from the
    stream, and the merge makes sure it shows once.
  - The header says *Live*, *Connecting…* or *Not live*. After a drop, the
    app re-reads decisions and autonomy to catch what it missed.
- **Checked:**
  - A Playwright test makes and undoes a decision through the API while the
    page is open, and sees both without a reload.
  - A throwaway listener counted 4,425 record changes during a full re-seed.
    All arrived and the connection held. The app waits for a pause in a
    burst before rebuilding.
- **Caught before it shipped:** the new live indicator first had
  `role="status"`, the same marker the screenshot script uses to detect a
  loading skeleton. Every screenshot would have waited 20 seconds for it.

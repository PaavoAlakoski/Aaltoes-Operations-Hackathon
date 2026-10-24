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

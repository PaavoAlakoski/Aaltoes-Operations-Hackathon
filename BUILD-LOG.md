# Build log

How we built Connection Watch with coding agents: what we asked for, what we checked,
what we threw away. Newest at the bottom of each day.

## Saturday 24 October

### Choosing the area
- Asked Claude Code to explain the brief and survey the four agent areas against the dataset.
  Picked **On the road**: the dataset has the most chained cases there (missed ships, tracking
  gaps, a safety stop) and it shows approval gates best.
- Narrowed it ourselves to a GPS connection watch: keep an ETA to the next hard transition
  (ferry check-in, train) and act before the margin is gone. Claude's first idea list was
  broader (breakdowns, receipts, handover reports); we kept those as later extensions.

### Architecture (docs/PLAN.md)
- Decision: **the ETA and margin maths is a pure function, not the model.** The LLM starts only
  when a watch gets worse or goes quiet. Cheaper, testable, and easy to explain.
- Decision: our tables are prefixed `cw_` with no foreign keys into the snapshot, because the
  starter's seed refuses to reseed when other tables reference its data.

### Phase 0–1: engine, clock, replay
- Checked before trusting: `drizzle-kit push` drops tables it does not see, so a separate schema
  file would have been silently dropped. Fixed by listing both files in `drizzle.config.ts`.
- **Threw away the first demo scenario B.** The plan used ord-00020 for the "phone goes quiet"
  story, but the data says it was delivered on 19 October, so replaying it would contradict its
  own order page. Searched the snapshot instead: five ferry bookings are still ahead of check-in
  on the snapshot morning (ord-00603, 00075, 00324, 00439, 00584). Now one clock runs all five,
  and ord-00324 carries the quiet-phone story.
- **Rejected a "crawling car" special case** in the engine that made a stopped car look like it
  would never arrive. Time passing with no progress already eats the margin; the special case
  would have turned a fuel stop into an alarm.
- **Wrote a dry-run script before wiring the database** (`npm run watch:dryrun`). It replays
  every car through the engine and prints state changes. It caught a false trigger: ord-00075
  went TIGHTENING on its first reading (no live speed yet) and recovered two minutes later.
  Fix: a first reading only triggers on a clear risk. Added a test.
- A unit test for the trend forecast failed. The engine was right, the test was wrong: its fake
  history did not lead into the current margin. Fixed the test, not the engine.
- Verified end to end at 240× speed over SSE: ord-00603 tightens at 09:52 UTC in the queue, at
  risk 10:53, missed 12:01 if nobody acts; ord-00324 goes stale and recovers without a second
  trigger; positions buffered offline arrive up to 36 min late with their original times.
- Open question: in a queue at 8 km/h the ETA still blends towards the planned 86 km/h, so the
  arrival time looks optimistic while the trend line warns correctly. To revisit when the
  control room shows these numbers.

### Phase 3: the agent
- Asked Claude Code how it would build the agent before writing any. Chose a **manual loop that
  pauses and resumes** over the SDK tool runner: a case waits minutes for a driver reply or a
  person's decision, so a run is a series of short bursts with the conversation stored in Postgres.
  The pause points (`wait_for`, `propose_action`, `close_run`) leave their tool call open and the
  wake-up answers it, so the history is append-only, as the current models require.
- Checked the installed SDK (1.3.0) before relying on features: `fallbacks: "default"`,
  mid-conversation `role: "system"` messages, strict tools and top-level cache control all exist.
  Operator instructions go in as system messages (operator authority); driver and carrier text is
  data inside tool results.
- Safety is code, not prompt: there is no tool that contacts a customer or books anything. Those are
  change kinds inside a proposal, and only the executor carries them out after a person approves,
  after rechecking capacity and sales close. Costs and the decide-by time are taken from the quotes;
  the end-to-end test proposes a fake €9,999.99 fare and checks the proposal shows the quoted €85.
- **Wrote the loop against interfaces first** (model, tools, store) and tested it with a scripted
  fake model: 10 tests, no API key. Then an end-to-end script against the real database with a
  scripted model: trigger → tools on real data → proposal → approve → executor → resume → close,
  plus the reject path.
- Mistakes the tests caught:
  - I named a function `process` in the service, shadowing Node's global, so `process.env` broke.
  - The e2e expected "inside the promised window" for the evening sailing; the code said "before the
    window", which was right (the car arrives early) but read like a problem. Reworded to "meets the
    promise" / "breaks the promise".
  - **My own UTC/local mix-up**: I had been calling the mock evening crossing "the 22:00 sailing", but
    it left at 22:00 UTC, which is 00:00 in Hamburg. Operators read local time. Moved it to 22:00
    local and set its sales close so the decide-by (13:25) comes before the original check-in
    closes (14:00). That is the point of a decide-by time.
- Demo pacing: model calls take seconds, which at 60× is many sim minutes, so the clock slows to 4×
  while the agent thinks and restores afterwards. To be stated in the README and the demo, not hidden.

### Delivery to the dealer, with opening hours
- Request: estimate whether the driver reaches the dealership in time, taking opening hours into
  account. Looked at the data first: every site has `opening_hours` (`mon_fri` / `sat` / `sun`,
  `null` = closed), five have `{}` (not recorded, which is not the same as closed), some ask for a
  call 30–60 min ahead, and one order's notes say "No after-hours drop".
- Caught a rule question before coding: the receiving dealer belongs to the customer, and the brief
  only allows contacting drivers and pickup places. So the agent never messages the dealer; it can
  remind the driver to make the call-ahead, and anything to the dealer is a draft a person sends.
- Built the hours logic as a pure module with tests first (time zones, the 25 Oct summer-time
  change, Saturday hours, closed Sunday, unknown hours, before-opening waits).
- The deadline is the end of the promised window, or the closing time if the site closes first.
  Arriving at a closed site is AT_RISK whatever the margin says.
- **Design gap found by the dry run**: a delivery watch went MISSED at the end of the promise and
  stopped watching, while the dealer was still open for two hours. A missed promise is not a missed
  delivery. Now the watch rolls over to the closing time, remembers the promise was broken, and
  stays AT_RISK until handover. MISSED means the site has closed.
- Tuned the story with the dry run, not by guessing: the first detour was too short (the car made
  the promise), the second still made it by 6 min; the third breaks the promise at 16:00 while the
  site is open until 18:00, which is the decision we want to show.
- Live check with an extra jam pushed arrival past 18:00 and showed "Next opening Thursday 09:00,
  about 15 h later". It also showed a call-ahead reminder for a time already past; removed.

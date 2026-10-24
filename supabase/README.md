# Supabase: the operations backend

One Supabase project serves three clients: the control room (`apps/control-room`, route `/live`),
the driver app (`apps/driver`) and the helper agent (`functions/agent-triage`,
`functions/execute-suggestion`). Everything here is code: migrations, seed, tests, functions.

The first five migrations are the v2 snapshot screens (`records`, `decisions`, `autonomy`, read by
anyone). The rest is the live operations backend and does not touch them.

| Migration | What it adds |
|---|---|
| `…141938_ops_schema` | corridors, vehicles, profiles, assignments, incidents, messages, agent_suggestions, audit_log; RLS on every table; the access token hook |
| `…142331_ops_rpcs` | the privileged writes as RPCs, and the `ops_kpis` view |
| `…142536_ops_realtime` | Postgres Changes publication; policies on `realtime.messages` for the private channels |
| `…143602_ops_agent` | ferry and hotel data, grouped proposals, webhook triggers via `pg_net`, the agent's read functions, `apply_suggestion`, the ferry scenario, the stale-car `pg_cron` job |
| `…145213_ops_scenario_reset` | the ferry scenario cleans up after itself, so it can be run again in a demo |
| `…150246_incident_source_default` | `incidents.source` has a default (the trigger always sets it) |
| `…151538_pg_net_schema` | `pg_net` lives in `extensions`, not the API schema |
| `…151921_ops_scenario_messages` | the scenario also clears the previous run's messages, so the agent starts from the same world |

Vocabulary: the brief's "lines" are **corridors** (routes cars are driven along, some with a ferry);
"vehicles" are **the cars being delivered**, one driver each.

## Who can do what

Roles live in `profiles.role` and are copied into the JWT as `app_role` and `vehicle_id` by
`custom_access_token_hook` (`role` itself is the Postgres role and cannot be reused). RLS reads the
claims and falls back to `profiles` when a token has none. The RPCs always read `profiles`, so a
demotion takes effect on the next call, not the next token refresh (tested).

| | driver | dispatcher | supervisor | agent (service role, edge functions only) |
|---|---|---|---|---|
| Cars | own car only | all | all | via `agent_*` functions |
| Other cars' positions | **no**: not needed to drive one car, and they are other people's whereabouts | live, on the map | live | nearby cars in the incident context |
| Incidents | read + report on own car | read, report, acknowledge, assign, resolve | same | raises none; reads context |
| Messages | to them, their car, their corridor; reply to staff only | read all, send to anyone | same | sends only by carrying out an approved move |
| Agent suggestions | none | read; approve or reject | same, plus car status changes | **insert only** |
| Car status | — | — | `set_vehicle_status` | via an approved move |
| Users | own profile | read all | `set_user_role` | — |
| Audit log | — | read | read | insert only |

Nobody writes tables directly except inserting incidents and messages, and column grants plus a
trigger stamp who sent them, from where and with what status, whatever the client sends. Every other
write is an RPC: `report_position`, `acknowledge_incident`, `assign_incident`, `resolve_incident`,
`decide_suggestion`, `set_vehicle_status`, `set_user_role`, `mark_message_read`, `simulate_ferry_jam`.
`anon` can read nothing here (it still reads the v2 snapshot tables, which the live deployment uses).

### Realtime

- **Postgres Changes** on `incidents`, `messages`, `agent_suggestions`, `vehicles`, `ferry_bookings`,
  `hotel_bookings`. Rows reach a subscriber only if RLS lets them select it.
- **Broadcast** `corridor:<id>` (private): a driver may only *send*, only on their own car's corridor;
  staff may only *listen*. Drivers send every 3 s; `report_position` stores one at most every 12–15 s.
- **Presence** `control-room` (private, staff only): who is on shift and which incident each has open.

Private channels are enforced by the policies on `realtime.messages`. The project's Realtime setting
"Allow public access" is still on because the v2 screens use public channels; turn it off once they
are retired, and every channel must then be private.

### The agent

```
incident inserted ──trigger (pg_net, async)──▶ agent-triage ──▶ Claude via OpenRouter, tool loop
                                                    │  check_pickup_feasibility, find_next_ferry, find_hotel_near_port
                                                    ▼
                                    agent_suggestions (one row per move, shared group_id)
person approves a move (decide_suggestion) ──trigger──▶ execute-suggestion ──▶ apply_suggestion
                                                                    (whitelisted moves only, audit_log)
```

- The functions authenticate the trigger with a secret that is generated in Vault by the migration and
  never leaves the database (`verify_agent_secret`), so there is nothing to copy into function env.
- The agent only ever *proposes*. Ids it uses must come from its own tool results; costs come from the
  data, not from the model.
- Failures (no key, API error, the model declining, a malformed proposal) are written to `audit_log` as
  `agent.triage_failed`; the incident is unaffected.
- `pg_cron` runs `app.flag_stale_vehicles()` every minute: a moving car silent for 2–10 minutes gets one
  `tracking_gap` incident. When the simulator stops, expect one per car, each triaged by the agent.

## Tests

`tests/*.test.sql` are pgTAP, each in one transaction that rolls back, so they are safe on the live
project. Each ends by selecting all its TAP lines as one `tap` value, because the SQL editor and the
Supabase MCP only show the last result. Paste a file into the SQL editor and read `tap`.

| File | Checks | |
|---|---|---|
| `01_rls.test.sql` | 36 | what each role can read and write, the hook, anon |
| `02_rpcs.test.sql` | 33 | every RPC's role checks, conflicts, the stale-token demotion |
| `03_realtime.test.sql` | 10 | who may send and listen on the private channels |
| `04_agent.test.sql` | 16 | the agent functions are service-role only, the scenario, carrying out moves |

`04` needs the seed (it uses car `veh-00584`).

## Run it locally

Needs Docker Desktop.

```sh
npx supabase start            # applies migrations/ and seed.sql, enables the access token hook
npx supabase status           # API URL and publishable key for the apps' .env files
```

Then, in the SQL editor at http://localhost:54323, point the triggers at the local functions:

```sql
select vault.create_secret('http://host.docker.internal:54321', 'project_url');
```

and serve the functions with the model key:

```sh
echo "OPENROUTER_API_KEY=sk-or-..." > supabase/functions/.env
npx supabase functions serve --env-file supabase/functions/.env
```

Local demo accounts (password `bahn-demo-local`, **local stack only**):

| Role | Email |
|---|---|
| Supervisor | `helena.starkwood@demo.bahn.test` |
| Dispatcher | `mira.kestelund@demo.bahn.test`, `oskar.brennvik@demo.bahn.test` |
| Driver | `leo.quellford@demo.bahn.test` (the ferry car), `zoe.bergalund@demo.bahn.test`, and the other 13 in `seed.sql` |

## The hosted project

Migrations are applied in order (`npx supabase db push`, or the Supabase MCP). Then:

1. **Seed** with your own password, never the local one, and never commit it:
   ```sql
   select set_config('seed.password', '<long random password>', false);
   -- then run seed.sql in the same session
   ```
2. **Vault**: `select vault.create_secret('https://<ref>.supabase.co', 'project_url');`
3. **Functions**: deploy `agent-triage` and `execute-suggestion` with JWT verification off (they check
   their own secret), and set the secret `OPENROUTER_API_KEY`. Optional: `OPENROUTER_MODEL`
   (default `anthropic/claude-opus-5.5`).
4. **Dashboard settings** that are not migrations:
   - Authentication → Hooks → Customize access token → `public.custom_access_token_hook`.
     Without it everything still works; RLS reads `profiles` instead of the token.
   - Authentication → Sign In / Providers → turn off "Allow new users to sign up". A sign-up gets a
     driver profile with no car and can see nothing, but there is no reason to allow it.

Never put the service role key or the model key in an app. The apps only ever get the project URL and
the publishable key.

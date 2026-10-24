// agent-triage: called by a database trigger when an incident is created.
// Reads the situation through the agent_* SQL functions, lets Claude (through
// OpenRouter) look up what it needs, and stores its proposal as moves in
// agent_suggestions for a person to approve one by one. It never carries
// anything out itself.
//
// Any failure (no key, the API down, a refusal, a malformed proposal) is
// written to audit_log and the incident simply has no suggestion; nothing
// here can block or undo the incident itself.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "anthropic/claude-opus-5.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TURNS = 8;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const SYSTEM = `You are the helper agent in Bahn's delivery control room. Bahn's freelance drivers drive used cars
one at a time across Finland, Denmark and Germany, often via a ferry. When something goes wrong with a car, you
look into it and propose what control should do. A dispatcher approves or rejects each move you propose; you never
act yourself, and nothing you propose happens unless a person approves it.

Work like this:
- Start from the incident context you are given. Use the tools to check what you need; do not guess times, prices,
  departures or hotels. Only use ids that a tool returned.
- If the car is booked on a ferry, call check_pickup_feasibility. If it will miss check-in, find the next ferry it
  can make (not_before = its ETA at the port) and, if that ferry leaves the next day, a cheap hotel near the port
  for the driver. That is a two-move recovery: rebook the ferry, then book the hotel.
- Otherwise propose the smallest set of moves that helps: usually one message to the driver, sometimes a corridor
  message, a status change, or escalation to a supervisor for anything safety-related (accident, damage).
- Finish by calling submit_proposal exactly once.

Writing:
- summary: one sentence a dispatcher can read in two seconds, naming the driver or car and what is at risk.
- checks: 3 to 6 short lines, each one fact you looked up and what it means for the plan ("ETA at Travemünde 20:58, check-in
  closes 20:30: misses by 28 min"). Times in the local time of the place they refer to, 24-hour clock.
- Each move gets a short imperative title ("Rebook to Sat 08:30 sailing").
- Messages to drivers are plain, short and friendly, in English; say what is decided and what to do next.
- Costs come from the tools; leave cost_cents null for moves that cost nothing.
- Never propose contacting a customer or dealer.`;

type ToolDef = { name: string; description: string; strict: boolean; input_schema: Record<string, unknown> };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; [extra: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

const tools: ToolDef[] = [
  {
    name: "check_pickup_feasibility",
    description:
      "Whether a car can still make what it is booked on. For a car with a ferry booking: ETA at the port from its last position and current delay, against check-in close. Otherwise its delivery ETA and delay.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { vehicle_id: { type: "string" } },
      required: ["vehicle_id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_next_ferry",
    description:
      "Up to three departures from a port whose check-in closes at or after not_before and that still have room for a car, with the rebooking fee in cents.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        from_port: { type: "string", description: "Port id, e.g. travemunde" },
        not_before: { type: "string", description: "ISO 8601 timestamp" },
      },
      required: ["from_port", "not_before"],
      additionalProperties: false,
    },
  },
  {
    name: "find_hotel_near_port",
    description: "Hotels near a port with rooms left, cheapest first, nightly rate in cents.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { port_id: { type: "string" } },
      required: ["port_id"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_proposal",
    description: "Submit your proposal for control to decide on. Call once, last.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        checks: { type: "array", items: { type: "string" }, description: "Facts looked up and what each means, in order." },
        moves: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["rebook_ferry", "book_hotel", "message_vehicle", "message_corridor", "set_vehicle_status", "escalate_incident"],
              },
              title: { type: "string" },
              rationale: { type: "string", description: "One sentence: why this move." },
              message: { type: ["string", "null"], description: "Text for the driver (or corridor). Required for message moves; optional for rebook/hotel." },
              departure_id: { type: ["string", "null"] },
              hotel_id: { type: ["string", "null"] },
              nights: { type: ["integer", "null"] },
              status: {
                type: ["string", "null"],
                enum: ["waiting_pickup", "moving", "stopped", "on_ferry", "needs_check", "delivered", "offline", null],
              },
              severity: { type: ["string", "null"], enum: ["low", "medium", "high", "critical", null] },
            },
            required: ["type", "title", "rationale", "message", "departure_id", "hotel_id", "nights", "status", "severity"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "checks", "moves"],
      additionalProperties: false,
    },
  },
];

type Move = {
  type: string;
  title: string;
  rationale: string;
  message: string | null;
  departure_id: string | null;
  hotel_id: string | null;
  nights: number | null;
  status: string | null;
  severity: string | null;
};
// "checks" is stored as reasoning_trace. The model is asked for the facts it
// checked, never for its "reasoning": with that wording in the schema every
// request came back declined (finish_reason content_filter); with "checks" it
// goes through.
type Proposal = { summary: string; checks: string[]; moves: Move[] };

// What the tools returned this run, so the proposal can only use real ids and
// its costs come from the data, not from the model.
type Seen = {
  departures: Map<string, { rebooking_fee_cents: number }>;
  hotels: Map<string, { nightly_rate_cents: number }>;
};

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

async function runTool(name: string, input: Record<string, string>, seen: Seen): Promise<unknown> {
  switch (name) {
    case "check_pickup_feasibility":
      return rpc("agent_check_pickup_feasibility", { p_vehicle_id: input.vehicle_id });
    case "find_next_ferry": {
      const rows = (await rpc("agent_find_next_ferry", {
        p_from_port: input.from_port,
        p_not_before: input.not_before,
      })) as Array<{ departure_id: string; rebooking_fee_cents: number }>;
      for (const r of rows) seen.departures.set(r.departure_id, r);
      return rows;
    }
    case "find_hotel_near_port": {
      const rows = (await rpc("agent_find_hotel_near_port", { p_port_id: input.port_id })) as Array<{
        hotel_id: string;
        nightly_rate_cents: number;
      }>;
      for (const r of rows) seen.hotels.set(r.hotel_id, r);
      return rows;
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Turns one proposed move into a row, or explains why it cannot be stored. */
function toRow(m: Move, seen: Seen): { row: Record<string, unknown> } | { error: string } {
  const base = { suggestion_type: m.type, title: m.title.slice(0, 120), rationale: m.rationale };
  switch (m.type) {
    case "rebook_ferry": {
      const dep = m.departure_id ? seen.departures.get(m.departure_id) : undefined;
      if (!dep) return { error: "rebook_ferry needs a departure_id returned by find_next_ferry" };
      return {
        row: { ...base, cost_cents: dep.rebooking_fee_cents || null, payload: { departure_id: m.departure_id, driver_message: m.message } },
      };
    }
    case "book_hotel": {
      const hotel = m.hotel_id ? seen.hotels.get(m.hotel_id) : undefined;
      if (!hotel) return { error: "book_hotel needs a hotel_id returned by find_hotel_near_port" };
      const nights = Math.min(Math.max(m.nights ?? 1, 1), 3);
      return {
        row: { ...base, cost_cents: hotel.nightly_rate_cents * nights, payload: { hotel_id: m.hotel_id, nights, driver_message: m.message } },
      };
    }
    case "message_vehicle":
    case "message_corridor":
      if (!m.message?.trim()) return { error: `${m.type} needs a message` };
      return { row: { ...base, payload: { body: m.message.trim().slice(0, 2000) } } };
    case "set_vehicle_status":
      if (!m.status) return { error: "set_vehicle_status needs a status" };
      return { row: { ...base, payload: { status: m.status } } };
    case "escalate_incident":
      return { row: { ...base, payload: { severity: m.severity ?? "high" } } };
    default:
      return { error: `unknown move ${m.type}` };
  }
}

async function audit(action: string, details: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_type: "agent", action, details });
}

async function triage(incidentId: string) {
  const context = await rpc("agent_incident_context", { p_incident_id: incidentId });
  if (!context) return { skipped: "no such incident" };

  const { count } = await db
    .from("agent_suggestions")
    .select("id", { count: "exact", head: true })
    .eq("incident_id", incidentId);
  if (count) return { skipped: "already triaged" };

  // The live project's secret was saved as "OPENROUTER_API_KEY." (trailing
  // period); accept it until it is renamed.
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("OPENROUTER_API_KEY.");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set for edge functions");

  const seen: Seen = { departures: new Map(), hotels: new Map() };
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `New incident. Context as JSON:\n${JSON.stringify(context, null, 2)}` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Bahn control room agent",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        messages,
        tools: tools.map(({ name, description, strict, input_schema }) => ({
          type: "function",
          function: { name, description, strict, parameters: input_schema },
        })),
        tool_choice: "auto",
        reasoning: { effort: "medium" },
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = await res.json();
    if (body.error) throw new Error(`OpenRouter: ${JSON.stringify(body.error).slice(0, 500)}`);
    const choice = body.choices?.[0];
    const message = choice?.message as Extract<ChatMessage, { role: "assistant" }> | undefined;
    if (!message) throw new Error("OpenRouter returned no message");
    if (choice.finish_reason === "content_filter" || choice.native_finish_reason === "refusal") {
      throw new Error(
        `model declined (finish ${choice.finish_reason}, native ${choice.native_finish_reason}): ${
          String(message.content ?? "").slice(0, 300)
        }`,
      );
    }

    // Keep the whole assistant message, reasoning details included: Claude
    // needs its earlier thinking passed back between tool calls.
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      throw new Error(`model stopped (${choice.finish_reason}) without submitting a proposal`);
    }

    const submit = calls.find((c) => c.function.name === "submit_proposal");
    if (submit) return await store(incidentId, JSON.parse(submit.function.arguments) as Proposal, seen);

    for (const call of calls) {
      let content: string;
      try {
        content = JSON.stringify(await runTool(call.function.name, JSON.parse(call.function.arguments), seen));
      } catch (e) {
        content = `Error: ${String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new Error(`no proposal after ${MAX_TURNS} turns`);
}

async function store(incidentId: string, p: Proposal, seen: Seen) {
  const groupId = crypto.randomUUID();
  const rows: Record<string, unknown>[] = [];
  const dropped: string[] = [];
  for (const m of p.moves.slice(0, 4)) {
    const r = toRow(m, seen);
    if ("error" in r) dropped.push(r.error);
    else rows.push(r.row);
  }
  if (rows.length === 0) throw new Error(`proposal had no usable moves: ${dropped.join("; ")}`);

  const trace = p.checks.slice(0, 8).map((s) => s.slice(0, 300));
  const { error } = await db.from("agent_suggestions").insert(
    rows.map((r, i) => ({
      ...r,
      incident_id: incidentId,
      group_id: groupId,
      step: i + 1,
      model: MODEL,
      reasoning_trace: trace,
      // The summary leads the first move's rationale, so a single-move
      // proposal still carries it.
      rationale: i === 0 ? `${p.summary}\n\n${r.rationale}` : r.rationale,
    })),
  );
  if (error) throw new Error(`storing the proposal: ${error.message}`);
  await audit("agent.propose", { incident_id: incidentId, group_id: groupId, moves: rows.length, dropped });
  return { group_id: groupId, moves: rows.length, dropped };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const { data: ok } = await db.rpc("verify_agent_secret", { p_secret: req.headers.get("x-agent-secret") ?? "" });
  if (ok !== true) return new Response("Forbidden", { status: 403 });

  let incidentId = "";
  try {
    incidentId = String((await req.json()).incident_id ?? "");
    if (!incidentId) return new Response("incident_id required", { status: 400 });
    const result = await triage(incidentId);
    return Response.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("agent-triage failed", incidentId, message);
    await audit("agent.triage_failed", { incident_id: incidentId || null, error: message.slice(0, 1000) });
    // 200: the failure is recorded; pg_net has nothing useful to retry.
    return Response.json({ failed: message });
  }
});

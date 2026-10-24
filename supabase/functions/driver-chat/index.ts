// driver-chat: the driver app's chat with the agent. Called by a signed-in
// driver with their own session. The agent answers what it can and tells
// control (by raising an incident) only when a problem delays the delivery by
// a day or more, the car breaks down, or it may cost extra. Everything else
// stays between the driver and the agent, so control's queue holds only what
// needs a person.
//
// The incident is inserted with the driver's own session, so the database
// stamps it as the driver's report and the agent_triage trigger works out the
// recovery for control as with any other report.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { driverEtaReport, keyPickupReport, loadPickupContext } from "../_shared/pickup.ts";

const MODEL = Deno.env.get("OPENROUTER_MODEL") ?? "anthropic/claude-opus-5.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TURNS = 6;
const HISTORY = 20;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM = `You are the assistant in the Bahn driver app. Bahn's freelance drivers drive used cars one at a time
across Finland, Denmark and Germany, often via a ferry. The driver you are talking to is on the road with one car.
You help them yourself, and you tell the control room only when it is needed.

Tell control (call notify_control_room) only when at least one of these is true:
- delay_1_day_plus: the problem delays the delivery by one day or more (a missed ferry whose next sailing is
  tomorrow, a car that cannot be picked up today, a repair that takes overnight).
- emergency_breakdown: the car cannot be driven or is not safe to drive (will not start, engine or gearbox
  failure, warning lights with smoke or loss of power, flat tyre with no spare, an accident).
- extra_costs: solving it may cost money beyond the normal trip (tow, repair, a hotel night, ferry rebooking, a
  new train or taxi, damage to the car, a fine).
Anything else you handle in the chat and do not pass on: traffic and delays of a few hours, directions, opening
hours, questions about the car or the route, small things on the car that do not stop the drive.

Work like this:
- The car's current state is given to you below. Use the tools to check times rather than guessing; when a delay
  matters, check the ETA before deciding whether it reaches a day.
- If you are unsure whether a criterion is met, ask the driver one short question first (for example: can the car
  still be driven safely?).
- If anyone is hurt or in danger, tell them to call 112 first.
- When you call notify_control_room, write the description for a dispatcher: one or two sentences with what
  happened, where, and what is at risk. Then tell the driver that control has been told and will contact them,
  and what to do meanwhile (stay safe, stay with the car).
- When you do not tell control, never say or suggest that control knows.
- Never promise money, bookings, reimbursements or a replacement driver yourself; control decides those.
- If control already has an open incident for the same problem, do not raise it again.

Writing: plain, short, friendly English, like a text message. 24-hour clock, local time of the place.`;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type LlmMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; [extra: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

const KINDS = ["breakdown", "accident", "delay", "car_not_ready", "documents", "ferry", "damage", "other"];
const REASONS = ["delay_1_day_plus", "emergency_breakdown", "extra_costs"];

const tools = [
  {
    name: "check_delivery",
    description:
      "Whether the car can still make what it is booked on. With a ferry booking: ETA at the port against check-in close. Otherwise its delivery ETA and delay.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "check_driver_eta",
    description:
      "For a car waiting for pickup: when the driver can be at the dealer (their train with its delay, then the drive), against the key handover.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "check_key_pickup",
    description: "The pickup dealer's opening hours, today's closing time and how keys are handed over.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "notify_control_room",
    description:
      "Raise an incident for the control room. Only for a delay of a day or more, an emergency breakdown, or possible extra costs. Once per problem.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", enum: REASONS },
        kind: { type: "string", enum: KINDS },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        description: { type: "string", description: "For the dispatcher: what happened, where, what is at risk." },
      },
      required: ["reason", "kind", "severity", "description"],
      additionalProperties: false,
    },
  },
].map(({ name, description, parameters }) => ({ type: "function", function: { name, description, strict: true, parameters } }));

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

async function audit(action: string, actorId: string, details: Record<string, unknown>) {
  await db.from("audit_log").insert({ actor_type: "agent", action, details: { ...details, driver_id: actorId } });
}

/** What the agent is told about the car before the conversation. */
async function carState(vehicleId: string) {
  const [v, open] = await Promise.all([
    db.from("vehicles").select("id,label,registration,order_ref,status,eta,delay_seconds,lat,lng,last_seen_at,corridor_id,pickup_eta,pickup_in_time")
      .eq("id", vehicleId).single(),
    db.from("incidents").select("id,kind,severity,status,source,description,created_at")
      .eq("vehicle_id", vehicleId).neq("status", "resolved").order("created_at", { ascending: false }).limit(5),
  ]);
  if (v.error) throw new Error(`vehicle: ${v.error.message}`);
  const [corridor, ferry, pickup] = await Promise.all([
    db.from("corridors").select("id,name").eq("id", v.data.corridor_id).maybeSingle(),
    db.from("ferry_bookings").select("status, departure:ferry_departures(operator,from_port,to_port,departs_at,check_in_closes_at)")
      .eq("vehicle_id", vehicleId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    loadPickupContext(db, vehicleId),
  ]);
  return {
    now: new Date().toISOString(),
    car: v.data,
    route: corridor.data,
    ferry_booking: ferry.data,
    pickup_site: pickup.site,
    driver_trip: pickup.trip,
    open_incidents_control_knows_about: open.data ?? [],
  };
}

type Run = {
  vehicleId: string | null;
  driverId: string;
  // deno-lint-ignore no-explicit-any
  asDriver: any;
  incidentId: string | null;
};

// deno-lint-ignore no-explicit-any
async function runTool(name: string, input: Record<string, any>, run: Run): Promise<unknown> {
  if (!run.vehicleId) return { error: "The driver is not on a car right now." };
  switch (name) {
    case "check_delivery":
      return rpc("agent_check_pickup_feasibility", { p_vehicle_id: run.vehicleId });
    case "check_driver_eta":
      return driverEtaReport(await loadPickupContext(db, run.vehicleId));
    case "check_key_pickup":
      return keyPickupReport(await loadPickupContext(db, run.vehicleId));
    case "notify_control_room": {
      if (run.incidentId) return { error: "Control has already been told in this reply." };
      if (!REASONS.includes(input.reason)) return { error: "reason must be one of " + REASONS.join(", ") };
      if (!KINDS.includes(input.kind)) return { error: "unknown kind" };
      const description = String(input.description ?? "").trim().slice(0, 1900);
      if (!description) return { error: "description is empty" };
      const since = new Date(Date.now() - 12 * 3600_000).toISOString();
      const { data: dup } = await db.from("incidents").select("id")
        .eq("vehicle_id", run.vehicleId).eq("kind", input.kind).eq("source", "driver").neq("status", "resolved")
        .gte("created_at", since).limit(1).maybeSingle();
      if (dup) return { error: "Control already has an open incident for this; it was not raised again.", incident_id: dup.id };
      const label = { delay_1_day_plus: "delay of a day or more", emergency_breakdown: "emergency breakdown", extra_costs: "possible extra costs" }[
        input.reason as string
      ];
      // As the driver: the database stamps it as their report and starts triage.
      const { data, error } = await run.asDriver.from("incidents").insert({
        vehicle_id: run.vehicleId,
        kind: input.kind,
        severity: input.severity,
        description: `${description} (From the driver chat: ${label}.)`,
      }).select("id").single();
      if (error) throw new Error(`raising the incident: ${error.message}`);
      run.incidentId = data.id;
      await audit("agent.chat_escalate", run.driverId, { incident_id: data.id, vehicle_id: run.vehicleId, reason: input.reason, kind: input.kind });
      return { raised: true, incident_id: data.id };
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

async function answer(run: Run, history: { role: string; body: string }[]): Promise<string> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY") ?? Deno.env.get("OPENROUTER_API_KEY.");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set for edge functions");
  const state = run.vehicleId ? await carState(run.vehicleId) : { now: new Date().toISOString(), car: null };
  const messages: LlmMessage[] = [
    { role: "system", content: `${SYSTEM}\n\nThe driver's car right now, as JSON:\n${JSON.stringify(state, null, 2)}` },
    ...history.map((m): LlmMessage => (m.role === "driver" ? { role: "user", content: m.body } : { role: "assistant", content: m.body })),
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Bahn driver chat" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages, tools, tool_choice: "auto", reasoning: { effort: "low" } }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body = await res.json();
    if (body.error) throw new Error(`OpenRouter: ${JSON.stringify(body.error).slice(0, 500)}`);
    const choice = body.choices?.[0];
    const message = choice?.message as Extract<LlmMessage, { role: "assistant" }> | undefined;
    if (!message) throw new Error("OpenRouter returned no message");
    if (choice.finish_reason === "content_filter" || choice.native_finish_reason === "refusal") {
      throw new Error(`model declined (finish ${choice.finish_reason}, native ${choice.native_finish_reason})`);
    }
    // Keep the whole assistant message, reasoning details included.
    messages.push(message);
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      const text = String(message.content ?? "").trim();
      if (!text) throw new Error(`model stopped (${choice.finish_reason}) without a reply`);
      return text.slice(0, 4000);
    }
    for (const call of calls) {
      let content: string;
      try {
        content = JSON.stringify(await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"), run));
      } catch (e) {
        content = `Error: ${String(e)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new Error(`no reply after ${MAX_TURNS} turns`);
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  const asDriver = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: who } = await asDriver.auth.getUser();
  if (!who.user) return json({ error: "Sign in first." }, 401);
  const { data: me } = await db.from("profiles").select("id,role,vehicle_id").eq("id", who.user.id).single();
  if (!me || me.role !== "driver") return json({ error: "The chat is for drivers." }, 403);

  let text = "";
  try {
    text = String((await req.json()).message ?? "").trim().slice(0, 4000);
  } catch { /* handled below */ }
  if (!text) return json({ error: "message required" }, 400);

  const { data: mine, error: e1 } = await db.from("driver_chat_messages")
    .insert({ driver_id: me.id, vehicle_id: me.vehicle_id, role: "driver", body: text }).select("*").single();
  if (e1) return json({ error: e1.message }, 500);

  const { data: past } = await db.from("driver_chat_messages").select("role,body")
    .eq("driver_id", me.id).order("created_at", { ascending: false }).limit(HISTORY);
  const history = (past ?? []).reverse();

  const run: Run = { vehicleId: me.vehicle_id, driverId: me.id, asDriver, incidentId: null };
  let reply: string;
  try {
    reply = await answer(run, history);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("driver-chat failed", me.id, message);
    await audit("agent.chat_failed", me.id, { error: message.slice(0, 1000), incident_id: run.incidentId });
    reply = run.incidentId
      ? "I've told control about this and they will contact you. I couldn't write more just now; stay safe and stay with the car."
      : "Sorry, I couldn't answer just now. Please try again in a minute. If it's urgent or anyone is hurt, call 112.";
  }
  const { data: theirs, error: e2 } = await db.from("driver_chat_messages")
    .insert({ driver_id: me.id, vehicle_id: me.vehicle_id, role: "agent", body: reply, incident_id: run.incidentId }).select("*").single();
  if (e2) return json({ error: e2.message }, 500);
  return json({ messages: [mine, theirs], escalated: run.incidentId });
});

// pickup-watch: is each driver on their way to a pickup still in time?
// Called by pg_cron every 20 minutes while someone has an app open (see
// app.someone_active), and with one vehicle_id by the
// train-delay scenario and after a driver is reassigned. For every car
// waiting for pickup it works out the driver's ETA at the dealer (their trip,
// then Google drive time) against the key handover, stores it on the car for
// the control room, and raises a delay incident the first time a driver will
// not make it. That incident wakes agent-triage through the usual trigger.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { computeEta, hhmm, type PickupContext } from "../_shared/pickup.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function watch(vehicleId: string) {
  const { data: ctx, error } = await db.rpc("agent_pickup_context", { p_vehicle_id: vehicleId });
  if (error) throw new Error(`agent_pickup_context: ${error.message}`);
  const c = ctx as PickupContext | null;
  if (!c || c.vehicle.status !== "waiting_pickup") return { vehicle_id: vehicleId, skipped: "not waiting for pickup" };

  const eta = await computeEta(c);
  await db.from("vehicles").update({
    pickup_eta: eta.eta,
    pickup_in_time: eta.in_time,
    pickup_checked_at: new Date().toISOString(),
    pickup_eta_basis: eta.basis,
  }).eq("id", vehicleId);

  if (eta.in_time !== false || !c.site) return { vehicle_id: vehicleId, in_time: eta.in_time };

  const { count } = await db.from("incidents").select("id", { count: "exact", head: true })
    .eq("vehicle_id", vehicleId).eq("kind", "delay").neq("status", "resolved");
  if (count) return { vehicle_id: vehicleId, in_time: false, incident: "already open" };

  const tz = c.site.timezone;
  const description = `${c.trip?.simulated ? "[Simulation] " : ""}${c.driver?.full_name ?? "The driver"} will not make the pickup of ${c.vehicle.label} at ${c.site.name}: ` +
    `ETA ${hhmm(eta.eta!, tz)}, keys ${c.site.key_handover === "key_box" ? "by key box" : "in person"} until ${c.site.closes_at ? hhmm(c.site.closes_at, tz) : "closing"} ` +
    `(${eta.minutes_late} min late). ${eta.basis}.`;
  const { data: inc, error: insErr } = await db.from("incidents")
    .insert({ vehicle_id: vehicleId, source: "system", kind: "delay", severity: "high", description: description.slice(0, 2000) })
    .select("id").single();
  if (insErr) throw new Error(`raising the incident: ${insErr.message}`);
  await db.from("audit_log").insert({ actor_type: "agent", action: "pickup.late", details: { vehicle_id: vehicleId, incident_id: inc.id, eta: eta.eta, steps: eta.steps } });
  return { vehicle_id: vehicleId, in_time: false, incident: inc.id };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const { data: ok } = await db.rpc("verify_agent_secret", { p_secret: req.headers.get("x-agent-secret") ?? "" });
  if (ok !== true) return new Response("Forbidden", { status: 403 });

  const body = await req.json().catch(() => ({}));
  let ids: string[];
  if (body.vehicle_id) ids = [String(body.vehicle_id)];
  else {
    const { data, error } = await db.rpc("agent_pickups_to_watch");
    if (error) return Response.json({ failed: error.message });
    ids = (data as unknown as string[]) ?? [];
  }

  const results = [];
  for (const id of ids) {
    try {
      results.push(await watch(id));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("pickup-watch failed", id, message);
      await db.from("audit_log").insert({ actor_type: "agent", action: "pickup.watch_failed", details: { vehicle_id: id, error: message.slice(0, 1000) } });
      results.push({ vehicle_id: id, failed: message });
    }
  }
  return Response.json({ checked: results });
});

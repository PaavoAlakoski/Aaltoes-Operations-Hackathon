// execute-suggestion: called by a database trigger when a person approves a
// move. Carries it out through apply_suggestion, which accepts only the moves
// it knows, checks the move is still approved, and writes the audit log. A
// failed move is marked failed with the reason; the decision itself stands.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const { data: ok } = await db.rpc("verify_agent_secret", { p_secret: req.headers.get("x-agent-secret") ?? "" });
  if (ok !== true) return new Response("Forbidden", { status: 403 });

  const suggestionId = String((await req.json().catch(() => ({}))).suggestion_id ?? "");
  if (!suggestionId) return new Response("suggestion_id required", { status: 400 });

  const { data, error } = await db.rpc("apply_suggestion", { p_suggestion_id: suggestionId });
  if (error) {
    console.error("execute-suggestion failed", suggestionId, error.message);
    await db.from("audit_log").insert({
      actor_type: "agent",
      action: "suggestion.execute_failed",
      details: { suggestion_id: suggestionId, error: error.message },
    });
    return Response.json({ failed: error.message });
  }
  return Response.json({ status: data.status, error: data.error });
});

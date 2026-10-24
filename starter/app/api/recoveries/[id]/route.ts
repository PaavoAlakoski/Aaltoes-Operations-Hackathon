import { NextResponse } from "next/server"
import { buildRecoveryPlan } from "@/lib/recovery/plan"

// Accepts an order id (ord-...) or reference (CD-...). Reads the dataset files only; no Postgres.
export const runtime = "nodejs"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const plan = await buildRecoveryPlan(id)
  if (!plan) return NextResponse.json({ error: "No open recovery for this order" }, { status: 404 })
  return NextResponse.json(plan)
}

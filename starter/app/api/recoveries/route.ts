import { NextResponse } from "next/server"
import { listRecoveryCases } from "@/lib/agent-tools"

// Reads the dataset files only. Does not need Postgres.
export const runtime = "nodejs"

export async function GET() {
  return NextResponse.json(await listRecoveryCases())
}

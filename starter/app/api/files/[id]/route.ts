import { readFile } from "node:fs/promises"
import { NextResponse } from "next/server"
import { attachmentPath, readAttachmentManifest, sha256 } from "@/lib/attachments"

export const runtime = "nodejs"

// Serves one fictional attachment from ../attachments, read-only. The manifest is
// the allow-list, and the bytes must still match its hash.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const attachment = (await readAttachmentManifest()).find((entry) => entry.id === id)
  if (!attachment) return NextResponse.json({ error: "File not found" }, { status: 404 })
  const bytes = await readFile(attachmentPath(attachment))
  if (sha256(bytes) !== attachment.sha256) return NextResponse.json({ error: "File does not match its manifest entry" }, { status: 409 })
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": attachment.content_type,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
    },
  })
}

import { subscribe, type WatchEvent } from "@/lib/watch/bus"
import { ensureServices } from "@/lib/boot"

export const runtime = "nodejs"

const HEARTBEAT_MS = 15000

// Server-Sent Events for the control room and the driver app.
// Optional filters: ?order=ord-00603 or ?assignment=asg-…
export async function GET(request: Request) {
  ensureServices()
  const url = new URL(request.url)
  const order = url.searchParams.get("order")
  const assignment = url.searchParams.get("assignment")
  const matches = (e: WatchEvent) => {
    if (e.type === "tick") return false
    if (e.type === "clock" || e.type === "reset") return true
    if (order && "orderId" in e && e.orderId !== order) return false
    if (assignment && "assignmentId" in e && e.assignmentId !== assignment) return false
    return true
  }

  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream({
    start(controller) {
      const send = (text: string) => {
        try { controller.enqueue(encoder.encode(text)) } catch { cleanup() }
      }
      const unsubscribe = subscribe((event) => { if (matches(event)) send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`) })
      const heartbeat = setInterval(() => send(": keep-alive\n\n"), HEARTBEAT_MS)
      cleanup = () => { unsubscribe(); clearInterval(heartbeat) }
      request.signal.addEventListener("abort", () => { cleanup(); try { controller.close() } catch {} })
      send(": connected\n\n")
    },
    cancel() { cleanup() },
  })

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  })
}

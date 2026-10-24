import "server-only"

import { asc, eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { emit } from "@/lib/watch/bus"
import { carNow } from "@/lib/watch/runner"
import { cwMessages } from "@/lib/watch/schema"
import { agentEnabled, driverReply } from "./model"
import { orderContext } from "./context"

// The simulated driver for the demo: a small model playing the driver, with a hidden truth per
// story and the car's live replay state. It answers in the driver app like a person would:
// after a minute or two, briefly, and only when the phone is online.

const REPLY_DELAY_MIN = 2

const HIDDEN_TRUTH: Record<string, string> = {
  "ord-00603": "You are stuck in a long queue on the A7 before the Elbe crossing south of Hamburg; a lane is closed and traffic barely moves. You and the car are fine. You do not know when it clears. If the ferry is missed you would rather take a hotel than sleep in the car, but you can do either.",
  "ord-00452": "A road on route 9 is closed after an accident and the police detour is slow, single-lane, through villages. You and the car are fine. You know the Tampere dealer wants a call before arrival but you have not called yet. You could deliver late afternoon if they are still open; you would rather not stay overnight.",
  "ord-00324": "Your phone was off the charger and the app stopped sending for about half an hour. You kept driving normally on the E4 towards Stockholm. You are fine, the car is fine, and you expect to make check-in comfortably.",
}
const GENERIC_TRUTH = "Everything is normal. You are driving towards the ferry terminal and expect to make check-in."

type Pending = { orderId: string; dueAt: Date; inFlight: boolean }
const store = globalThis as unknown as { __cwSimDriver?: Map<string, Pending> }
const pending = (store.__cwSimDriver ??= new Map())

export function onAgentMessagedDriver(orderId: string, _body: string, _quickReplies: string[], at: Date): void {
  pending.set(orderId, { orderId, dueAt: new Date(at.getTime() + REPLY_DELAY_MIN * 60000), inFlight: false })
}

export function resetSimDriver(): void {
  pending.clear()
}

// Called every runner tick. `deliver` hands the reply to the agent service.
export async function simDriverTick(now: Date, deliver: (orderId: string, body: string, at: Date) => Promise<void>): Promise<void> {
  for (const p of pending.values()) {
    if (p.inFlight || p.dueAt > now) continue
    const car = carNow(p.orderId, now)
    if (car && !car.online) continue // a dead phone answers nothing
    p.inFlight = true
    try {
      const body = await compose(p.orderId, now)
      pending.delete(p.orderId)
      await db.insert(cwMessages).values({ orderId: p.orderId, runId: null, party: "driver", direction: "in", body, quickReplies: [], at: now })
      emit({ type: "message", orderId: p.orderId, party: "driver", direction: "in", body, quickReplies: [], at: now.toISOString() })
      await deliver(p.orderId, body, now)
    } catch (error) {
      console.error("[sim driver]", error)
      p.inFlight = false
    }
  }
}

async function compose(orderId: string, now: Date): Promise<string> {
  const thread = await db.select().from(cwMessages).where(eq(cwMessages.orderId, orderId)).orderBy(asc(cwMessages.at))
  const lastQuestion = [...thread].reverse().find((m) => m.party === "agent")
  if (!agentEnabled() || process.env.DRIVER_MODE === "canned") return lastQuestion?.quickReplies[0] ?? "All fine."

  const ctx = await orderContext(orderId)
  const car = carNow(orderId, now)
  const live = car
    ? `Right now: ${Math.round(car.kmToGo)} km from the terminal, ${car.arrived ? "at the terminal" : `driving at about ${Math.round(car.speedKmh)} km/h`}${car.zone ? ` (${car.zone})` : ""}.`
    : ""
  const system = `You play ${ctx.driver?.name ?? "a freelance car delivery driver"} in a demo. You are driving a ${ctx.car?.name ?? "car"} for Bahn to a ferry. You are a calm, practical professional. Hidden truth (do not recite it, just behave consistently with it): ${HIDDEN_TRUTH[orderId] ?? GENERIC_TRUTH} ${live}
Reply like a real driver in a chat app: one or two short sentences, sometimes slightly imprecise about place names. If the question offers quick replies and one fits, answer with exactly that quick reply, optionally followed by a few words. Answer what you know; it is fine to skip part of a question. Never invent problems that are not in the hidden truth.`
  const transcript = thread.map((m) => `${m.party === "agent" ? "Bahn" : "You"}: ${m.body}${m.quickReplies.length ? ` [quick replies: ${m.quickReplies.join(" | ")}]` : ""}`).join("\n")
  return driverReply(system, `Chat so far:\n${transcript}\n\nWrite your next reply only.`)
}

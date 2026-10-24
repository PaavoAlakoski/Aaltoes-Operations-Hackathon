// What agents may do without asking. Reading and asking need no yes; a customer
// is never contacted by an agent; everything that changes a booking, a date or
// a cost starts at "ask first" and can be loosened as an agent earns trust.

export type Level = "ask_first" | "act_then_tell" | "on_its_own"

export type ActionKind = {
  key: string
  name: string
  text: string
  defaultLevel: Level
  /** Set by the rules of the job, not by a setting. */
  locked: boolean
  lockReason?: string
}

export const LEVELS: { key: Level; label: string; hint: string }[] = [
  { key: "ask_first", label: "Ask first", hint: "Brings you a proposal; nothing changes until you say yes." },
  { key: "act_then_tell", label: "Act, then tell", hint: "Acts, then posts what it did on the order so you can undo it." },
  { key: "on_its_own", label: "On its own", hint: "Acts and records it. You see it in the order history." },
]

export const ACTION_KINDS: ActionKind[] = [
  { key: "look_up", name: "Read records and look things up", text: "Order history, quotes, timetables, ferry capacity, site hours.", defaultLevel: "on_its_own", locked: true, lockReason: "Looking things up never needs a yes." },
  { key: "ask_driver_site", name: "Ask a driver or a pickup place", text: "Questions such as “are you safe?”, “is the car ready?”, “send a photo of the warning light”.", defaultLevel: "on_its_own", locked: true, lockReason: "Asking questions never needs a yes." },
  { key: "message_customer", name: "Write to a customer", text: "Anyone who pays us. The agent drafts; a person sends.", defaultLevel: "ask_first", locked: true, lockReason: "An agent never contacts a customer on its own." },
  { key: "publish_offer", name: "Publish a reviewed offer to drivers", text: "Simple domestic jobs whose facts are confirmed.", defaultLevel: "act_then_tell", locked: false },
  { key: "change_booking", name: "Book or change travel", text: "Ferries, trains, flights and hotels for a driver. Stops before any real purchase.", defaultLevel: "ask_first", locked: false },
  { key: "change_date", name: "Change a pickup slot or delivery date", text: "Any change to a time a customer or site relies on.", defaultLevel: "ask_first", locked: false },
  { key: "approve_cost", name: "Approve a cost", text: "Driver expenses, extra travel, waiting time.", defaultLevel: "ask_first", locked: false },
  { key: "resolve_alert", name: "Close an alert", text: "When a recorded reply or event settles what the alert was about.", defaultLevel: "ask_first", locked: false },
]

export type AgentRecord = {
  id: string
  title: string
  scope: string
  proposed: number
  approved: number
  changed: number
  rejected: number
  failed: number
  waiting: number
}

export type AgentsView = { agents: AgentRecord[]; kinds: (ActionKind & { level: Level })[] }

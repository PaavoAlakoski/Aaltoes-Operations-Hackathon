"use client"

import { useState } from "react"
import type { TimelineEntry } from "@/lib/present/case"
import { fmtDateTime, fmtWeekday, fmtClock } from "@/lib/present/time"

type Filter = "all" | "talk" | "agents" | "people" | "system"

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "talk", label: "Messages" },
  { key: "agents", label: "Agents" },
  { key: "people", label: "People at Bahn" },
  { key: "system", label: "Records" },
]

function matches(entry: TimelineEntry, filter: Filter): boolean {
  if (filter === "all") return true
  if (filter === "talk") return entry.kind === "message"
  if (filter === "agents") return entry.actor.kind === "agent"
  if (filter === "people") return entry.actor.kind === "operator" && entry.kind !== "event"
  return entry.kind === "event"
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase()
}

function dotClass(entry: TimelineEntry): string {
  if (entry.kind === "decision") return "you"
  const kind = entry.actor.kind
  if (kind === "agent") return "agent"
  if (kind === "operator") return "operator"
  if (kind === "customer" || kind === "handoff_contact") return "customer"
  if (kind === "system") return "system"
  return ""
}

const ROLE: Partial<Record<TimelineEntry["actor"]["kind"], string>> = {
  agent: "agent", operator: "Bahn", driver: "driver", customer: "customer", site_contact: "site", handoff_contact: "handoff contact",
}

/** Who said and did what, newest first, in one place. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const [filter, setFilter] = useState<Filter>("all")
  const [all, setAll] = useState(false)
  const visible = entries.filter((entry) => matches(entry, filter))
  const shown = all ? visible : visible.slice(0, 10)
  return <>
    <div className="tl-filters" role="group" aria-label="Show">
      {FILTERS.map((option) => <button type="button" key={option.key} className="desk" aria-pressed={filter === option.key} onClick={() => setFilter(option.key)}>{option.label}</button>)}
    </div>
    {visible.length === 0 && <p className="empty">Nothing of this kind is recorded on this order.</p>}
    <div className="timeline">{shown.map((entry) => <div className={`tl ${entry.kind}${entry.internal ? " internal" : ""}`} key={entry.id}>
      <span className={`who-dot ${dotClass(entry)}`} aria-hidden="true">{entry.kind === "decision" ? "You" : entry.actor.kind === "system" ? "·" : initials(entry.actor.name)}</span>
      <div>
        <div className="tl-head">
          <b>{entry.actor.name}</b>
          {ROLE[entry.actor.kind] && entry.kind !== "decision" && <span>{ROLE[entry.actor.kind]}</span>}
          {entry.kind === "message" && entry.meta && <span>· {entry.meta}</span>}
          {entry.internal && entry.kind === "message" && <span className="msg-tag internal">Internal</span>}
        </div>
        {entry.kind !== "message" && <div className={`tl-title tone-${entry.tone}`}>{entry.title}</div>}
        {entry.body && <div className="tl-body">{entry.body}</div>}
        {entry.kind !== "message" && entry.meta && <div className="tl-meta">{entry.meta}</div>}
      </div>
      <time dateTime={entry.at} title={fmtDateTime(entry.at)}>{fmtWeekday(entry.at)} {fmtClock(entry.at)}</time>
    </div>)}</div>
    {visible.length > 10 && <button type="button" className="show-more" onClick={() => setAll((value) => !value)}>{all ? "Show the latest only" : `Show all ${visible.length}`}</button>}
  </>
}

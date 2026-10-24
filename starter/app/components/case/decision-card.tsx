"use client"

import { useState } from "react"
import type { CaseAction, CaseItem, DecidedItem, EvidenceRef } from "@/lib/present/case"
import { fmtDateTime, relativeTo } from "@/lib/present/time"
import { Icon } from "../icons"

const ICON: Record<CaseItem["kind"], string> = {
  alert: "alert", owned_alert: "alert", work: "work", incident: "incident", waiting: "waiting", conversation: "message",
  proposal: "proposal", claim: "alert", custody: "key", check: "note", inbox: "inbox",
}

const EVIDENCE_ICON: Record<string, string> = { Message: "message", Event: "waiting", Alert: "alert", Order: "file" }

const FROM = { record: "from the record", agent: "agent", playbook: "playbook" } as const

export function DecisionCard({ item, orderId, snapshotAt, showNext, onDecided, compact = false }: {
  item: CaseItem; orderId: string; snapshotAt: string | null; showNext: boolean; onDecided: () => void; compact?: boolean
}) {
  const [expanded, setExpanded] = useState(!compact)
  const [chosen, setChosen] = useState<CaseAction | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const proposal = item.proposal
  const when = item.at ? relativeTo(item.at, snapshotAt)?.text : null

  async function confirm() {
    if (!chosen) return
    if (chosen.needsNote && !note.trim()) { setError("Add a short note so the next person knows why."); return }
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/decisions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, targetId: item.recordId, action: chosen.action, note: note.trim() || null }),
      })
      if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save the decision")
      onDecided()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the decision")
      setBusy(false)
    }
  }

  if (!expanded) return <button type="button" className={`drow tone-${item.tone}`} onClick={() => setExpanded(true)} aria-expanded="false">
    <Icon name={ICON[item.kind]} className={`tone-${item.tone}`} />
    <span className="drow-main"><span className={`drow-title tone-${item.tone}`}>{item.title}</span>{item.detail && <span className="drow-detail">{item.detail}</span>}</span>
    <span className="drow-side">{item.owner ?? "No owner yet"}{when ? <><br />{item.atLabel} {when}</> : null}</span>
    <Icon name="chevron" size={13} className="drow-chev" />
  </button>

  return <article className={`dcard tone-${item.tone}`} id={`item-${item.recordId}`}>
    <div className="dcard-top">
      <Icon name={ICON[item.kind]} className={`tone-${item.tone}`} />
      <div className={`dcard-title tone-${item.tone}`}>{title(item)}</div>
      <div className="dcard-src">{item.sourceKind}{when ? ` · ${item.atLabel ?? ""} ${when}` : ""}<br />{item.owner ? `Owner: ${item.owner}` : "No owner yet"}</div>
      {item.detail && !proposal && <p className="dcard-detail">{item.detail}</p>}
    </div>

    <div className="dcard-body">
      {proposal && <div className={`suggest${proposal.error ? " failed" : ""}`}>
        <div className="suggest-who"><Icon name="bot" size={14} />{proposal.agent} · {proposal.statusLabel.toLowerCase()}</div>
        <p className="suggest-what">{proposal.summary}</p>
        {proposal.rationale && <p className="suggest-why"><b>Why:</b> {proposal.rationale}</p>}
        {proposal.error && <p className="suggest-why tone-danger"><b>What went wrong:</b> {proposal.error}</p>}
        {proposal.steps.length > 0 && <ul className="suggest-steps">{proposal.steps.map((step) => <li key={step}>{step}</li>)}</ul>}
        {(proposal.touchesCustomer || proposal.recheck) && <div className="suggest-flags">
          {proposal.touchesCustomer && <span className="chip tone-warn">Involves the customer: you send anything to them</span>}
          {proposal.recheck && <span className="chip tone-neutral">Re-checks the order before acting</span>}
        </div>}
        {proposal.priorReview && <p className="suggest-prior">Earlier review: {proposal.priorReview}</p>}
      </div>}

      {showNext && !proposal && item.next && item.next.text !== item.detail && <p className="dcard-next"><Icon name="arrow" size={14} /><span><b>Next:</b> {item.next.text}<span className={`from-tag ${item.next.from}`}>{FROM[item.next.from]}</span></span></p>}

      {item.evidence.length > 0 && <Evidence refs={item.evidence} />}

      <div className="dactions">
        {item.actions.map((action) => <button type="button" key={action.action}
          className={`btn small${action.primary ? " primary" : ""}${chosen?.action === action.action ? " chosen" : ""}`}
          onClick={() => { setChosen(chosen?.action === action.action ? null : action); setError("") }}
          aria-expanded={chosen?.action === action.action}>{action.label}</button>)}
        {compact ? <button type="button" className="btn small quiet dactions-hint" onClick={() => { setExpanded(false); setChosen(null) }}>Fold away</button>
          : <span className="dactions-hint">You see what happens before anything is saved.</span>}
      </div>

      {chosen && <div className="confirm">
        <div className="confirm-head">If you choose “{chosen.label}”</div>
        <ol className="effects">{chosen.effects.map((effect) => <li key={effect.text} className={effect.needsPerson ? "you" : undefined}>{effect.text.replace("“…”", "your note")}</li>)}</ol>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder={chosen.needsNote ? "Required: a short note for the agent and the next person" : "Optional note"} aria-label="Note" />
        {error && <p className="confirm-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn primary" onClick={confirm} disabled={busy}>{busy ? "Saving…" : `Confirm: ${chosen.label}`}</button>
          <button type="button" className="btn quiet" onClick={() => setChosen(null)} disabled={busy}>Cancel</button>
        </div>
      </div>}
    </div>
  </article>
}

/** A proposal card says what is asked of you; other items keep their record title. */
function title(item: CaseItem): string {
  if (!item.proposal) return item.title
  if (item.proposal.error) return `${item.proposal.agent}: the action failed`
  if (item.proposal.priorReview) return `${item.proposal.agent}: approved, ready to run`
  return `${item.proposal.agent} needs your yes`
}

function Evidence({ refs }: { refs: EvidenceRef[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? refs : refs.slice(0, 3)
  return <div className="based">
    <div className="based-head">Based on</div>
    <div className="based-list">{shown.map((ref) => <div className="based-item" key={ref.id}>
      <Icon name={EVIDENCE_ICON[ref.kind] ?? "file"} size={14} />
      <div>
        <div className="based-meta"><b>{ref.kind}</b>{ref.who ? ` from ${ref.who}` : ""}{ref.at ? ` · ${fmtDateTime(ref.at)}` : ""}</div>
        <div className={`based-text${ref.kind === "Message" ? " quote" : ""}`}>{ref.text}</div>
      </div>
    </div>)}</div>
    {refs.length > 3 && <button type="button" className="show-more" onClick={() => setAll((value) => !value)}>{all ? "Show less" : `Show all ${refs.length} sources`}</button>}
  </div>
}

export function DoneCard({ entry, onUndone }: { entry: DecidedItem; onUndone: () => void }) {
  const [busy, setBusy] = useState(false)
  async function undo() {
    setBusy(true)
    await fetch(`/api/decisions/${entry.decision.id}`, { method: "DELETE" })
    onUndone()
  }
  return <article className="done-card">
    <div className="done-top"><Icon name="check" />{entry.actionLabel} by you · {fmtDateTime(entry.decision.decidedAt)}
      <button type="button" className="btn small quiet" onClick={undo} disabled={busy}>{busy ? "Undoing…" : "Undo"}</button>
    </div>
    <p className="done-what">{entry.item.title}{entry.item.detail ? `: ${entry.item.detail}` : ""}</p>
    {entry.decision.note && <p className="done-note">“{entry.decision.note}”</p>}
    <ol className="effects">{entry.decision.effects.map((effect) => <li key={effect.text} className={effect.needsPerson ? "you" : undefined}>{effect.text}</li>)}</ol>
  </article>
}

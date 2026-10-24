"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { fmtDateTime, fmtDay } from "@/lib/present/time"
import type { InboxThreadView, InboxView } from "@/lib/present/types"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"
import { ActorName, Chip, OrderLink, OrderLinks, When } from "../components/ui"

export default function InboxPage() {
  const [view, setView] = useState<InboxView | null>(null)
  const [error, setError] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const [matches, setMatches] = useState<Match[]>([])

  const load = useCallback((signal?: AbortSignal) => {
    fetch("/api/inbox", { signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("Could not load the inbox"); return response.json() as Promise<{ view: InboxView; matches: Match[] }> })
      .then((data) => {
        setView(data.view)
        setMatches(data.matches)
        setError("")
        const wanted = window.location.hash.replace(/^#/, "")
        setSelected((current) => current ?? (data.view.threads.find((thread) => thread.id === wanted) ?? data.view.threads[0])?.id ?? null)
      })
      .catch((cause: unknown) => { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load the inbox") })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const thread = useMemo(() => view?.threads.find((item) => item.id === selected) ?? null, [view, selected])

  const choose = (id: string) => {
    setSelected(id)
    setShowList(false)
    window.history.replaceState(null, "", `#${id}`)
  }

  return <AppFrame section="inbox" snapshotAt={view?.snapshotAt ?? null}><main className={`mailbox${showList ? "" : " reading"}`}>
    <section className="mail-list" aria-label="Support inbox threads">
      <header className="mail-list-head">
        <h1>Support inbox</h1>
        <p>{view ? `${view.open} of ${view.threads.length} open` : "Loading"} · arrived before an order link was certain</p>
      </header>
      {error && <p className="board-error" role="alert">{error}.</p>}
      <ul className="mail-rows">{view?.threads.map((item) => {
        const last = item.messages[item.messages.length - 1]
        return <li key={item.id}>
          <button type="button" className={`mail-row${item.id === selected ? " active" : ""}`} onClick={() => choose(item.id)} aria-current={item.id === selected ? "true" : undefined}>
            <span className="mail-row-top">
              <span className="mail-row-who">{item.counterparty?.name ?? "Unknown sender"}</span>
              <span className="mail-row-when">{fmtDay(item.updatedAt)}</span>
            </span>
            <span className="mail-row-subject">{item.categoryLabel}<Chip tone={item.linkTone}>{item.linkStateLabel}</Chip></span>
            {last && <span className="mail-row-preview">{last.body}</span>}
          </button>
        </li>
      })}</ul>
    </section>
    <section className="mail-read" aria-label="Conversation">
      {!view && !error && <p className="empty">Loading…</p>}
      {view && !thread && <p className="empty">Choose a thread.</p>}
      {thread && <Thread thread={thread} matches={matches.filter((match) => match.threadId === thread.id)} onChange={() => load()} onBack={() => setShowList(true)} />}
    </section>
  </main></AppFrame>
}

type Match = { id: string; threadId: string; orderId: string; action: string; at: string }

/** Which order is this message about? A candidate is a guess until a person links it. */
function MatchPanel({ thread, matches, onChange }: { thread: InboxThreadView; matches: Match[]; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const linked = matches.find((match) => match.action === "link")
  async function decide(orderId: string, action: "link" | "not_this_order") {
    setBusy(true)
    setError("")
    const response = await fetch("/api/decisions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId, targetId: thread.id, action }) })
    if (!response.ok) setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save")
    setBusy(false)
    onChange()
  }
  async function undo() {
    setBusy(true)
    for (const match of matches) await fetch(`/api/decisions/${match.id}`, { method: "DELETE" })
    setBusy(false)
    onChange()
  }
  if (linked) {
    const order = thread.candidates.find((candidate) => candidate.id === linked.orderId)
    return <div className="done-card" style={{ marginTop: 18 }}>
      <div className="done-top"><Icon name="check" />Linked by you to <OrderLink order={order ?? { id: linked.orderId, reference: linked.orderId }} />
        <button type="button" className="btn small quiet" onClick={undo} disabled={busy}>Undo</button></div>
      <ol className="effects"><li>The message is filed on that order and leaves the unmatched inbox.</li><li>The other candidates are ruled out. Nothing about them was shared with the sender.</li></ol>
    </div>
  }
  return <div className="confirm" style={{ marginTop: 18 }}>
    <div className="confirm-head">Which order is this about?</div>
    <p className="note-text" style={{ marginTop: 4 }}>The candidates are guesses from the message. Linking one files the message there and rules out the others.</p>
    <div className="rules">{thread.candidates.map((candidate) => {
      const ruledOut = matches.some((match) => match.orderId === candidate.id && match.action === "not_this_order")
      return <div className="rule" key={candidate.id} style={{ padding: "10px 0" }}>
        <div className="rule-name"><OrderLink order={candidate} />{ruledOut && <span className="row-sub-inline"> · ruled out by you</span>}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => decide(candidate.id, "link")}>It’s this order</button>
          {!ruledOut && <button type="button" className="btn small" disabled={busy} onClick={() => decide(candidate.id, "not_this_order")}>Not this one</button>}
        </div>
      </div>
    })}</div>
    {error && <p className="confirm-error" role="alert">{error}</p>}
  </div>
}

function Thread({ thread, matches, onChange, onBack }: { thread: InboxThreadView; matches: Match[]; onChange: () => void; onBack: () => void }) {
  return <article>
    <button type="button" className="mail-back" onClick={onBack}><Icon name="chevron" size={13} style={{ transform: "rotate(180deg)" }} /> All threads</button>
    <header className="mail-head">
      <h2>{thread.categoryLabel}</h2>
      <div className="chips">
        <Chip tone={thread.linkTone}>{thread.linkStateLabel}</Chip>
        <Chip tone={thread.tone}>{thread.statusLabel}</Chip>
      </div>
      <dl className="mail-facts">
        <div><dt>From</dt><dd>{thread.counterparty ? <><ActorName actor={thread.counterparty} /> <span className="muted">({thread.counterparty.role})</span></> : "Unknown"}</dd></div>
        <div><dt>Channel</dt><dd>{thread.channelLabel}</dd></div>
        <div><dt>Owner</dt><dd>{thread.owner ?? "Not recorded"}</dd></div>
        {thread.waitingOn && <div><dt>Waiting on</dt><dd>{thread.waitingOn}</dd></div>}
        <div><dt>Opened</dt><dd><When at={thread.openedAt} withZone={false} /></dd></div>
        {thread.linked.length > 0 && <div><dt>Linked orders</dt><dd><OrderLinks orders={thread.linked} /></dd></div>}
        {thread.candidates.length > 0 && !thread.linked.length && <div><dt>Candidates</dt><dd><OrderLinks orders={thread.candidates} /> <span className="muted">hypotheses, not links</span></dd></div>}
        {thread.resolution && <div><dt>Resolution</dt><dd>{thread.resolution.decisionLabel}{thread.resolution.at ? `, ${fmtDateTime(thread.resolution.at)}` : ""}</dd></div>}
      </dl>
      {thread.candidateBasis && <p className="mail-basis"><b>Why these candidates.</b> {thread.candidateBasis}</p>}
      {thread.candidates.length > 0 && !thread.linked.length && thread.status === "OPEN" && <MatchPanel thread={thread} matches={matches} onChange={onChange} />}
    </header>
    <div className="messages mail-messages">{thread.messages.map((message) => <div className={`msg${message.internal ? " internal" : message.author.kind === "operator" ? " from-operator" : ""}`} key={message.id}>
      <div className="msg-meta"><b><ActorName actor={message.author} /></b><span className="role">{message.author.role}</span><span>to {message.recipient.name}</span><span>· {message.channelLabel}</span>{message.internal && <span className="msg-tag internal">Internal</span>}<time dateTime={message.at}>{fmtDateTime(message.at)}</time></div>
      <p className="msg-body">{message.body}</p>
    </div>)}</div>
    {thread.messages.length === 0 && <p className="empty">No messages filed under this thread.</p>}
  </article>
}

"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { fmtClock, fmtDateTime, fmtRange } from "@/lib/present/time"
import type { Bucket, QueueRow, QueueView } from "@/lib/present/triage"
import { AppFrame } from "./components/app-frame"
import { Icon } from "./components/icons"

const GROUPS: { key: Exclude<Bucket, "quiet">; label: string; hint: string }[] = [
  { key: "decide", label: "Decide now", hint: "Something is at risk, or an agent is waiting for your yes." },
  { key: "follow_up", label: "Follow up", hint: "Open checks and threads nobody else is holding." },
  { key: "waiting", label: "Waiting on others", hint: "Someone owns it or an answer is due. Check back at the time shown." },
]

const FROM_LABEL = { record: "from the record", agent: "agent", playbook: "playbook" } as const

export default function Queue() {
  const router = useRouter()
  const [queue, setQueue] = useState<QueueView | null>(null)
  const [error, setError] = useState("")
  const [search, setSearch] = useState("")
  const [bucket, setBucket] = useState<Bucket | "all">("all")
  const [desk, setDesk] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/queue", { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Could not load the queue"); return response.json() as Promise<QueueView> })
      .then((data) => { setQueue(data); setError("") })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load the queue") })
    return () => controller.abort()
  }, [])

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return (queue?.rows ?? []).filter((row) =>
      (bucket === "all" || row.bucket === bucket)
      && (!desk || row.desks.includes(desk))
      && (!query || row.search.includes(query)))
  }, [queue, search, bucket, desk])
  const ordered = useMemo(() => GROUPS.flatMap((group) => rows.filter((row) => row.bucket === group.key)), [rows])

  useEffect(() => { setActive(0) }, [search, bucket, desk])

  // j/k to move, Enter to open, / to search. Only when no field has focus.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || event.metaKey || event.ctrlKey || event.altKey) {
        if (event.key === "Escape" && target === searchRef.current) searchRef.current?.blur()
        return
      }
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus() }
      else if (event.key === "j" || event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, ordered.length - 1)) }
      else if (event.key === "k" || event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)) }
      else if (event.key === "Enter" && ordered[active]) router.push(`/orders/${ordered[active].id}`)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [ordered, active, router])

  useEffect(() => {
    document.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const needing = queue ? queue.counts.decide + queue.counts.follow_up + queue.counts.waiting : null
  const filtering = !!search.trim() || bucket !== "all" || !!desk

  return <AppFrame section="queue" snapshotAt={queue?.snapshotAt ?? null} count={queue?.counts.decide ?? null}><main className="qpage">
    <div className="qhead">
      <div>
        <h1>Needs you</h1>
        <p className="qsummary">{queue
          ? <><b className="tone-danger">{queue.counts.decide}</b> to decide now · <b>{queue.counts.follow_up}</b> to follow up · <b>{queue.counts.waiting}</b> waiting on others · {queue.quiet} of {queue.total} orders on track</>
          : "Reading every order…"}</p>
      </div>
      <div className="qtools">
        <span className="qkeys"><span className="kbd">j</span> <span className="kbd">k</span> move · <span className="kbd">↵</span> open</span>
        <label className="search">
          <span className="sr-only">Search the queue</span>
          <Icon name="search" />
          <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Car, reference, customer, city or desk" />
          {search ? <button type="button" className="search-clear" onClick={() => setSearch("")} aria-label="Clear search"><Icon name="arrow" size={14} style={{ transform: "rotate(45deg)" }} /></button> : <span className="kbd">/</span>}
        </label>
      </div>
    </div>

    {queue && <div className="qbar">
      <div className="segments" role="group" aria-label="Show">
        <button type="button" className="segment" aria-pressed={bucket === "all"} onClick={() => setBucket("all")}>All <span className="num">{needing}</span></button>
        {GROUPS.map((group) => <button type="button" key={group.key} className="segment" aria-pressed={bucket === group.key} onClick={() => setBucket(group.key)}>
          <span className={`seg-dot ${group.key}`} />{group.label} <span className="num">{queue.counts[group.key]}</span>
        </button>)}
      </div>
      {queue.desks.length > 0 && <div className="desks" role="group" aria-label="Desk">
        <span className="desks-label">Desk</span>
        {queue.desks.map((entry) => <button type="button" key={entry.name} className="desk" aria-pressed={desk === entry.name} onClick={() => setDesk((current) => current === entry.name ? null : entry.name)}>{entry.name}</button>)}
      </div>}
    </div>}

    {error && <p className="qerror" role="alert">{error}. Check that the server is running.</p>}
    {!queue && !error && <div aria-busy="true" aria-label="Loading">{[0, 1, 2, 3, 4].map((index) => <div className="qskeleton" key={index} />)}</div>}

    {queue && needing === 0 && <div className="qempty"><h2>Nothing needs you right now</h2><p>Every order is either on track or waiting on someone else. New alerts and agent proposals will appear here.</p></div>}
    {queue && needing !== 0 && ordered.length === 0 && <div className="qempty"><h2>No match</h2><p>{search.trim() ? <>Nothing waiting matches “{search.trim()}”.</> : "Nothing in this view."} <button type="button" className="show-more" onClick={() => { setSearch(""); setBucket("all"); setDesk(null) }}>Show everything</button></p></div>}

    {GROUPS.map((group) => {
      const list = ordered.filter((row) => row.bucket === group.key)
      if (!list.length) return null
      const offset = ordered.indexOf(list[0])
      return <section className="qgroup" key={group.key} aria-labelledby={`g-${group.key}`}>
        <div className="qgroup-head"><h2 id={`g-${group.key}`}>{group.label}</h2><span className="num">{list.length}</span><p>{group.hint}</p></div>
        <div className="qlist">{list.map((row, index) => <Row key={row.id} row={row} index={offset + index} active={offset + index === active} />)}</div>
      </section>
    })}

    {queue && !filtering && queue.quiet > 0 && <div className="qquiet">
      <Icon name="check" />
      <span><b>{queue.quiet} orders are on track.</b> Nothing in their records is waiting on a person, so they stay out of your way.</span>
      <Link href="/orders">See all orders</Link>
    </div>}

    {queue && queue.decided.length > 0 && <section className="decided" aria-labelledby="decided-head">
      <div className="qgroup-head"><h2 id="decided-head">Decided this shift</h2><span className="num">{queue.decided.length}</span><p>What happens next, for each decision you made.</p></div>
      {queue.decided.map((entry) => <div className="decided-row" key={entry.id}>
        <time dateTime={entry.at} title={fmtDateTime(entry.at)}>{fmtClock(entry.at)}</time>
        <div>
          <div><b>{entry.actionLabel}</b> · {entry.what} on <Link href={`/orders/${entry.orderId}`}>{entry.vehicle} <span className="qcar-ref">{entry.reference}</span></Link></div>
          {entry.next && <div className={`decided-next${entry.needsPerson ? " you" : ""}`}>{entry.needsPerson ? "Still on you: " : "Next: "}{entry.next}</div>}
        </div>
      </div>)}
    </section>}
  </main></AppFrame>
}

function Row({ row, index, active }: { row: QueueRow; index: number; active: boolean }) {
  const clock = row.clock
  return <Link href={`/orders/${row.id}`} className={`qrow tone-${row.tone}${active ? " active" : ""}`} data-row={index} aria-current={active ? "true" : undefined}>
    <div className="qcar">
      <div className="qcar-name">{row.vehicle}</div>
      <div className="qcar-ref">{row.reference} · {row.laneLabel}</div>
      <div className="qcar-route"><span>{row.from}</span><Icon name="arrow" size={12} /><span>{row.to}</span></div>
      <div className="qcar-customer">{row.customer}</div>
    </div>
    <div className="qwhat">
      <div className={`qreason tone-${row.tone}`}>{row.reason}{row.more > 0 && <span className="more">+{row.more} more</span>}</div>
      {row.why && row.why !== row.next?.text && <div className="qwhy">{row.why}</div>}
      {row.next && <div className="qnext"><Icon name="arrow" size={14} /><span className="qnext-text">{row.next.text}<span className={`from-tag ${row.next.from}`}>{FROM_LABEL[row.next.from]}</span></span></div>}
    </div>
    <div className="qwhen">
      {clock ? <>
        <div className="qclock-label">{clock.label}</div>
        <div className={`qclock tone-${clock.tone}`} title={fmtDateTime(clock.start, clock.zone)}>{clock.note ?? fmtRange(clock.start, clock.end, clock.zone)}</div>
      </> : <div className="qclock-label">No date set</div>}
      <div className="qwho">
        {row.agent && <span className={`agent-tag tone-${row.agent.tone}`}><Icon name="bot" size={12} />{row.agent.name}: {row.agent.text}</span>}
        <span>{row.owner ? `Owner: ${row.owner}` : "No owner yet"}</span>
      </div>
    </div>
  </Link>
}

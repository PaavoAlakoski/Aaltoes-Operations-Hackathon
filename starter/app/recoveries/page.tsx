"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { CheckCircle2, CircleAlert } from "lucide-react"
import { fmtDateTime, relativeTo } from "@/lib/present/time"
import type { CaseList, RecoveryPlan } from "@/lib/recovery/types"
import { ImpactTree } from "../components/ImpactTree"

type PlanState = { id: string; plan?: RecoveryPlan; error?: string }

export default function RecoveriesPage() {
  const [list, setList] = useState<CaseList | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [listAttempt, setListAttempt] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [planState, setPlanState] = useState<PlanState | null>(null)
  const [planAttempt, setPlanAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/recoveries", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`The list returned status ${response.status}`)
        return response.json() as Promise<CaseList>
      })
      .then((data) => { setList(data); setListError(null) })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setListError(cause instanceof Error ? cause.message : "The list could not be loaded")
      })
    return () => controller.abort()
  }, [listAttempt])

  useEffect(() => {
    if (!selectedId) return
    const controller = new AbortController()
    fetch(`/api/recoveries/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) throw new Error("This recovery is no longer open.")
        if (!response.ok) throw new Error("This recovery could not be loaded.")
        return response.json() as Promise<RecoveryPlan>
      })
      .then((plan) => setPlanState({ id: selectedId, plan }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setPlanState({ id: selectedId, error: cause instanceof Error ? cause.message : "This recovery could not be loaded." })
      })
    return () => controller.abort()
  }, [selectedId, planAttempt])

  const cases = list?.cases ?? []
  const loadingPlan = selectedId !== null && planState?.id !== selectedId
  const plan = planState?.id === selectedId ? planState.plan : undefined
  const planError = planState?.id === selectedId ? planState.error : undefined

  function select(id: string) {
    setSelectedId(id)
  }

  let main: React.ReactNode
  if (listError) {
    main = <div className="rc-empty" role="alert">
      <CircleAlert size={28} aria-hidden="true" className="rc-empty-icon" />
      <h2>The recoveries could not be loaded</h2>
      <p>{listError}. Check that the app is running.</p>
      <button type="button" className="rc-btn is-secondary" onClick={() => { setList(null); setListError(null); setListAttempt((count) => count + 1) }}>Try again</button>
    </div>
  } else if (!list) {
    main = <div className="rc-skel-stage" aria-busy="true" aria-label="Loading recoveries"><div className="rc-skel rc-skel-title" /><div className="rc-skel rc-skel-block" /><div className="rc-skel rc-skel-block" /></div>
  } else if (!selectedId) {
    main = cases.length === 0
      ? <div className="rc-empty">
          <CheckCircle2 size={28} aria-hidden="true" className="rc-empty-icon" />
          <h2>No driver recoveries are waiting. Inbox zero.</h2>
          <p>Checked alerts on all {list.checkedOrders} orders at the snapshot.</p>
        </div>
      : <div className="rc-empty">
          <CheckCircle2 size={28} aria-hidden="true" className="rc-empty-icon" />
          <h2>Pick a recovery on the left</h2>
          <p>{cases.length === 1 ? "1 needs a decision" : `${cases.length} need a decision`}</p>
        </div>
  } else if (loadingPlan) {
    main = <div className="rc-skel-stage" aria-busy="true" aria-label="Loading recovery"><div className="rc-skel rc-skel-title" /><div className="rc-skel rc-skel-block" /><div className="rc-skel rc-skel-block" /></div>
  } else if (planError) {
    main = <div className="rc-empty" role="alert">
      <CircleAlert size={28} aria-hidden="true" className="rc-empty-icon" />
      <h2>This recovery could not be opened</h2>
      <p>{planError}</p>
      <button type="button" className="rc-btn is-secondary" onClick={() => { setPlanState(null); setPlanAttempt((count) => count + 1) }}>Try again</button>
    </div>
  } else if (plan) {
    main = <ImpactTree key={plan.orderId} plan={plan} />
  } else {
    main = null
  }

  return <div className="rc-shell">
    <aside className="rc-side" aria-label="Recoveries">
      <div className="rc-side-top">
        <Link href="/" className="rc-wordmark">Control Room</Link>
        <div className="rc-side-title">
          <h2>Recoveries</h2>
          {list && <span className="rc-count num" aria-label={`${cases.length} open`}>{cases.length}</span>}
        </div>
      </div>
      <ul className="rc-list">
        {!list && !listError && [0, 1, 2].map((index) => <li key={index}><div className="rc-skel rc-skel-item" /></li>)}
        {cases.map((item) => {
          const selected = item.id === selectedId
          const relative = item.pickupSlot ? relativeTo(item.pickupSlot.start, list?.snapshotAt) : null
          return <li key={item.id}>
            <button type="button" className={`rc-item${selected ? " is-selected" : ""}`} aria-pressed={selected} onClick={() => select(item.id)}>
              <span className="rc-item-top">
                <span className="rc-dot" aria-hidden="true" />
                <span className="sr-only">Needs a person:</span>
                <span className="rc-item-ref mono">{item.reference}</span>
              </span>
              <span className="rc-item-car">{item.carMake} {item.carModel}</span>
              <span className="rc-item-reason">{item.reason}</span>
              {item.pickupSlot && relative && <span className="rc-item-time num">Pickup {relative.text} · {fmtDateTime(item.pickupSlot.start, item.pickupSlot.timezone)}</span>}
            </button>
          </li>
        })}
      </ul>
      <footer className="rc-side-foot">
        <p>{list ? `Snapshot ${fmtDateTime(list.snapshotAt)} · Fictional data` : "Fictional data"}</p>
        <nav className="rc-side-links" aria-label="Other pages">
          <Link href="/orders">All orders</Link>
          <Link href="/inbox">Inbox</Link>
        </nav>
      </footer>
    </aside>
    <main className="rc-main" id="main">{main}</main>
  </div>
}

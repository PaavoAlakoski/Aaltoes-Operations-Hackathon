"use client"

import { useState } from "react"
import { AlertTriangle, Bed, BriefcaseBusiness, CheckCircle2, Car, CircleAlert, Clock, Lock, MapPin, Phone, UserPlus, UserRound } from "lucide-react"
import { fmtDateTime, fmtRange } from "@/lib/present/time"
import type { MoveNode, RecoveryPlan, SourceRef } from "@/lib/recovery/types"
import type { DoubleRecoveryProposal } from "@/lib/agent-tools"
import "./double-recovery.css"

// The decision tree for one recovery. Nothing here is sent: approvals only update this screen.

const TABLE_LABELS: Record<string, string> = {
  messages: "Message",
  alerts: "Alert",
  market_offers: "Open job",
  work_assignments: "Assignment",
  drivers: "Driver record",
  orders: "Order record",
  time_windows: "Time window",
  agent_proposals: "Agent proposal",
  operational_events: "Event",
}

function isActionable(node: MoveNode): boolean {
  return (node.kind === "offer" && node.options.length > 0) || node.kind === "person" || node.kind === "release"
}

export function ImpactTree({ plan, doubleRecovery }: { plan: RecoveryPlan; doubleRecovery?: DoubleRecoveryProposal }) {
  const [done, setDone] = useState<Record<string, boolean>>({})
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [log, setLog] = useState<{ id: number; text: string }[]>([])

  const tz = plan.slot?.timezone ?? plan.pickup.timezone ?? "UTC"
  const nodes = [...plan.carBranch, ...plan.driverBranch]
  const isLocked = (node: MoveNode) => node.dependsOn.some((id) => !done[id])
  const nextId = nodes.find((node) => isActionable(node) && !done[node.id] && !isLocked(node))?.id ?? null
  const closing = plan.pickup.closingTime ? `closes ${plan.pickup.closingTime} local` : (plan.pickup.hoursNote ?? "Hours not recorded")
  const slotText = plan.slot ? fmtRange(plan.slot.start, plan.slot.end, plan.slot.timezone) : "No slot recorded"

  function complete(node: MoveNode) {
    const chosen = node.options.find((option) => option.id === (picked[node.id] ?? node.options[0]?.id))
    const text = `${node.log}${chosen ? `: ${chosen.label}` : ""}. ${node.doneNote}`
    setDone((state) => ({ ...state, [node.id]: true }))
    setLog((lines) => [...lines, { id: lines.length + 1, text }])
  }

  const renderNode = (node: MoveNode) => (
    <NodeView
      key={node.id}
      node={node}
      done={!!done[node.id]}
      locked={isLocked(node)}
      next={node.id === nextId}
      picked={picked[node.id] ?? node.options[0]?.id ?? null}
      onPick={(id) => setPicked((state) => ({ ...state, [node.id]: id }))}
      onComplete={() => complete(node)}
    />
  )

  return (
    <article className="rc-tree" aria-label={`Recovery for ${plan.reference}`}>
      {doubleRecovery && <DoubleRecoveryPanel proposal={doubleRecovery} />}
      <header className="rc-head">
        <h1 className="rc-car">{plan.car.make} {plan.car.model}</h1>
        <div className="rc-head-line">
          <span className="chip tone-neutral mono">{plan.reference}</span>
          <span className="rc-head-where"><MapPin size={14} aria-hidden="true" />Waiting at {plan.pickup.name}, {plan.pickup.city} · {closing}</span>
        </div>
        <p className="rc-head-slot"><Clock size={14} aria-hidden="true" />Selected slot {slotText}</p>
        <p className="rc-head-customer">For {plan.customerName} <span>Only a person contacts the customer.</span></p>
      </header>

      <section className="rc-root" aria-labelledby="rc-root-title">
        <p className="rc-kicker">What happened</p>
        <h2 id="rc-root-title">{plan.root.headline}</h2>
        <p className="rc-summary">{plan.root.summary}</p>
        {plan.root.keyEvents.length > 0 && <ol className="rc-events">
          {plan.root.keyEvents.map((event) => <li key={`${event.source.table}-${event.source.id}-${event.at}`}>
            <div className="rc-event-meta">
              <SourceChip label={event.recordType} time={fmtDateTime(event.at)} source={event.source} />
              <span className="rc-event-who">{event.who}</span>
            </div>
            <p className="rc-event-text">{event.text}</p>
          </li>)}
        </ol>}
        {plan.root.priorWork.length > 0 && <div className="rc-prior">
          <p className="rc-kicker">Agent work already on this order</p>
          <ul>{plan.root.priorWork.map((item) => <li key={item.source.id}>
            <span className="rc-prior-status">{item.statusLabel}</span>
            <span>{item.summary}</span>
            {item.decisionNote && <span className="rc-prior-note">Reviewer: {item.decisionNote}</span>}
          </li>)}</ul>
        </div>}
      </section>

      <p className="rc-sim">Simulated. Nothing is sent.</p>
      <div className="rc-branches">
        <section className="rc-branch" aria-labelledby="rc-car-title">
          <header className="rc-branch-head">
            <Car size={16} aria-hidden="true" />
            <h2 id="rc-car-title">The car</h2>
            <span>{plan.signal === "POSITIONING_AT_RISK" ? "Needs a driver for the slot" : "Needs a backup if the driver is not fit"}</span>
          </header>
          <ol className="rc-nodes">{plan.carBranch.map(renderNode)}</ol>
          {plan.alternative && <p className="rc-alt">
            {plan.alternative.text} <SourceChip label={TABLE_LABELS[plan.alternative.source.table] ?? "Record"} source={plan.alternative.source} />
          </p>}
        </section>

        <section className="rc-branch" aria-labelledby="rc-driver-title">
          <header className="rc-branch-head">
            <UserRound size={16} aria-hidden="true" />
            <h2 id="rc-driver-title">The driver</h2>
            <span>{plan.driver.name}{plan.driver.earliestAvailableAt ? `, free after ${fmtDateTime(plan.driver.earliestAvailableAt, tz)}` : ""}</span>
          </header>
          <ol className="rc-nodes">{plan.driverBranch.map(renderNode)}</ol>
        </section>
      </div>

      <section className="rc-log" aria-labelledby="rc-log-title">
        <h2 id="rc-log-title">Decisions</h2>
        {log.length === 0
          ? <p className="rc-log-empty">Nothing approved on this screen yet.</p>
          : <ol>{log.map((line) => <li key={line.id}><span className="rc-log-time">just now</span>{line.text}</li>)}</ol>}
      </section>

      <ul className="rc-caveats" aria-label="Limits of this data">
        {plan.caveats.map((text) => <li key={text}>{text}</li>)}
      </ul>
    </article>
  )
}

function NodeView({ node, done, locked, next, picked, onPick, onComplete }: {
  node: MoveNode
  done: boolean
  locked: boolean
  next: boolean
  picked: string | null
  onPick: (id: string) => void
  onComplete: () => void
}) {
  const actionable = isActionable(node)
  const showOptions = node.options.length > 0 && !done && !locked
  const Head = locked ? Lock : done ? CheckCircle2 : node.kind === "person" ? Phone : node.kind === "explain" ? CircleAlert : node.lane === "car" ? Car : UserRound
  const classes = ["rc-node", done ? "is-done" : "", locked ? "is-locked" : "", next && !done ? "is-next" : ""].filter(Boolean).join(" ")

  return (
    <li className={classes} aria-current={next && !done ? "step" : undefined}>
      <div className="rc-node-head">
        <span className="rc-node-icon" aria-hidden="true"><Head size={16} /></span>
        <div className="rc-node-text">
          <h3>{node.title}</h3>
          <p>{node.body}</p>
        </div>
        {done && <span className="sr-only">Done</span>}
      </div>

      {node.quote && <figure className="rc-quote">
        <blockquote>{node.quote.text}</blockquote>
        <figcaption>{node.quote.who} <SourceChip label={node.quote.recordType} time={undefined} source={node.quote.source} /></figcaption>
      </figure>}

      {showOptions && <ul className="rc-options" role="radiogroup" aria-label="Choose one">
        {node.options.map((option) => {
          const active = picked === option.id
          return <li key={option.id}>
            <button type="button" role="radio" aria-checked={active} className={`rc-option${active ? " is-picked" : ""}`} onClick={() => onPick(option.id)}>
              <span className="rc-option-label">{option.label}</span>
              <span className="rc-option-detail">{option.detail}</span>
            </button>
          </li>
        })}
      </ul>}

      {locked && node.lockedText && <p className="rc-locked"><Lock size={13} aria-hidden="true" />{node.lockedText}</p>}

      {!done && !locked && actionable && <div className="rc-actions">
        <button type="button" className={`rc-btn${node.kind === "person" ? " is-secondary" : ""}`} onClick={onComplete}>{node.actionLabel}</button>
        {node.note && <span className="rc-person"><Phone size={13} aria-hidden="true" />{node.note}</span>}
      </div>}

      {done && <p className="rc-done">{node.doneNote}</p>}

      {node.sources.length > 0 && !done && <div className="rc-sources">
        {node.sources.map((source) => <SourceChip key={`${source.table}-${source.id}`} label={TABLE_LABELS[source.table] ?? "Record"} source={source} />)}
      </div>}
    </li>
  )
}

function SourceChip({ label, time, source }: { label: string; time?: string; source: SourceRef }) {
  return <span className="chip tone-neutral rc-source" title={`${source.id} (${source.table})`}>
    Source: {label}{time ? ` · ${time}` : ""}
  </span>
}

// ---- Double recovery (train delay) --------------------------------------------------------------
// One glance: is the driver in time? Then why, and the two moves a person approves.
// Approving only records the decision on this screen; nothing is booked or sent.

export function DoubleRecoveryPanel({ proposal }: { proposal: DoubleRecoveryProposal }) {
  const [approved, setApproved] = useState<Record<"move1" | "move2", boolean>>({ move1: false, move2: false })
  const late = !proposal.driverInTime
  const { move1, move2 } = proposal

  return (
    <section className="mb-8 flex flex-col gap-5" aria-label={`Double recovery for ${proposal.orderRef}`}>
      <div
        role="status"
        className={`flex items-center gap-4 rounded-xl px-6 py-6 text-white shadow-lg ${late ? "bg-red-600" : "bg-emerald-600"}`}
      >
        {late ? <AlertTriangle className="size-12 shrink-0" aria-hidden="true" /> : <CheckCircle2 className="size-12 shrink-0" aria-hidden="true" />}
        <div>
          <p className="text-3xl font-black tracking-tight sm:text-4xl">
            {late ? "DRIVER DELAYED - PICKUP WILL FAIL" : "DRIVER ON TIME - PICKUP STILL POSSIBLE"}
          </p>
          <p className="mt-1 text-base text-white/90">
            <span className="font-mono">{proposal.orderRef}</span> · {late ? "Two moves below need your yes." : "No recovery needed."}
            {proposal.computedWithoutModel && " · Computed without the model"}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-stone-300 bg-white px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Why</p>
        <ol className="mt-2 flex flex-col gap-1.5">
          {proposal.reasoningTrace.map((line, i) => (
            <li key={i} className="flex gap-3 text-[15px] leading-snug text-stone-800">
              <span className="w-5 shrink-0 text-right font-mono text-stone-400">{i + 1}</span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-stone-500">Train position and times, hotels and tomorrow&apos;s jobs are mock data. The order, dealer hours, handover rule and drivers come from the dataset.</p>
      </div>

      {late && (
        <div className="grid gap-4 md:grid-cols-2">
          <MoveCard
            n={1}
            icon={<UserPlus className="size-7" aria-hidden="true" />}
            title={move1.title}
            lines={[
              { icon: <Car className="size-4" aria-hidden="true" />, text: `Collects the car: ${move1.pickupWhen}` },
              { icon: <MapPin className="size-4" aria-hidden="true" />, text: move1.distanceKm === 0 ? `Based in ${move1.fromCity}, the dealer's city` : `${move1.distanceKm} km from the dealer (based in ${move1.fromCity})` },
            ]}
            note={move1.note}
            caveat={move1.caveat}
            approved={approved.move1}
            onApprove={() => setApproved((a) => ({ ...a, move1: true }))}
            after={`${move1.driverName} is asked first. If they say yes, the pickup moves to them and the dealer is told who is coming.`}
          />
          <MoveCard
            n={2}
            icon={<Bed className="size-7" aria-hidden="true" />}
            title={move2.title}
            lines={[
              { icon: <Bed className="size-4" aria-hidden="true" />, text: `${move2.hotel.name}, ${move2.hotel.city} · €${move2.hotel.nightlyEur} tonight` },
              { icon: <BriefcaseBusiness className="size-4" aria-hidden="true" />, text: `Tomorrow: ${move2.nextJob.route}, pickup ${move2.nextJob.pickup} · €${move2.nextJob.feeEur}` },
            ]}
            note={move2.note}
            caveat={move2.caveat}
            approved={approved.move2}
            onApprove={() => setApproved((a) => ({ ...a, move2: true }))}
            after={`${move2.strandedDriverName} gets the hotel and is offered the job; it is theirs only if they accept.`}
          />
        </div>
      )}

      <div className="rounded-xl border border-dashed border-stone-300 px-5 py-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Draft for the customer · a person reviews and sends it</p>
        <p className="mt-1 text-[15px] text-stone-800">{proposal.customerDraft}</p>
      </div>
    </section>
  )
}

function MoveCard({ n, icon, title, lines, note, caveat, approved, onApprove, after }: {
  n: number
  icon: React.ReactNode
  title: string
  lines: { icon: React.ReactNode; text: string }[]
  note: string
  caveat: string
  approved: boolean
  onApprove: () => void
  after: string
}) {
  return (
    <article className={`flex flex-col gap-4 rounded-xl border-2 bg-white p-5 ${approved ? "border-emerald-500" : "border-stone-300"}`}>
      <header className="flex items-start gap-3">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-800">{icon}</span>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Move {n}</p>
          <h3 className="m-0 text-xl font-bold leading-tight text-stone-900">{title}</h3>
        </div>
      </header>
      <ul className="flex flex-col gap-2">
        {lines.map((line) => (
          <li key={line.text} className="flex items-start gap-2 text-[15px] text-stone-800">
            <span className="mt-0.5 text-stone-500">{line.icon}</span>
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-stone-700">{note}</p>
      <p className="text-xs text-stone-500">{caveat}</p>
      {approved ? (
        <p role="status" className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800">
          <CheckCircle2 className="size-5" aria-hidden="true" /> Approved. {after}
        </p>
      ) : (
        <button
          type="button"
          onClick={onApprove}
          className="mt-auto cursor-pointer rounded-lg border-0 bg-stone-900 px-4 py-3 text-base! font-semibold! text-white! hover:bg-stone-700"
        >
          Approve move {n}
        </button>
      )}
    </article>
  )
}

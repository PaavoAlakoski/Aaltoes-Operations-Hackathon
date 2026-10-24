"use client"

import Image from "next/image"
import Link from "next/link"
import type { CaseView } from "@/lib/present/case"
import type { RecordView } from "@/lib/present/types"
import { DecisionCard, DoneCard } from "./case/decision-card"
import { FactsPanel } from "./case/facts"
import { Timeline } from "./case/timeline"
import { Icon } from "./icons"
import { RecordsPanel } from "./record/records"
import { EvidenceSection, RouteStrip } from "./record/sections"
import { SectionHead } from "./ui"

export type Detail = { order: { id: string; reference: string }; view: RecordView; case: CaseView }

export function OrderPane({ detail, onChange }: { detail: Detail; onChange: () => void }) {
  const { view } = detail
  const { header, story } = view
  const vehicle = header.vehicle
  // One decision in full: the agent's proposal when there is one, since it
  // usually answers the others. The rest stay one line each until opened.
  const open = detail.case.open
  const lead = open.findIndex((item) => item.proposal && !item.proposal.priorReview) >= 0
    ? open.findIndex((item) => item.proposal && !item.proposal.priorReview)
    : open.findIndex((item) => item.proposal) >= 0 && open[0]?.tone !== "danger" ? open.findIndex((item) => item.proposal) : 0
  const items = open.length ? [open[lead], ...open.filter((_, index) => index !== lead)] : []
  // Several items on one order often share one next step, such as reviewing the
  // agent's proposal. Say it once, on the first card.
  const seen = new Set<string>()
  const showNext = items.map((item) => {
    const text = item.next?.text ?? ""
    if (!text || seen.has(text)) return false
    seen.add(text)
    return true
  })

  return <>
    <header className="case-head">
      <figure className="case-thumb" title="Model illustration. It is not a photo or evidence of this car.">
        {vehicle?.illustrationSlug
          ? <Image src={`/car-images/${vehicle.illustrationSlug}.webp`} alt={`Illustration of a ${vehicle.title}`} fill sizes="156px" priority />
          : null}
      </figure>
      <div>
        <h1 className="case-title">{vehicle ? vehicle.title : "Vehicle not linked"}</h1>
        <div className="chips">
          <span className="chip-fact"><span className={`dot lane-${header.lane}`} /><span className="mono">{header.reference}</span>{header.laneLabel}</span>
          <span className="chip-fact"><Icon name="pin" size={13} />{header.from.city} <Icon name="arrow" size={12} /> {header.to.city}{view.journey.distanceKm ? ` · ${view.journey.distanceKm} km` : ""}</span>
          <Link className="chip-fact link" href={`/customers/${header.customer.id}`}><Icon name="people" size={13} />{header.customer.name}</Link>
          <span className={`chip-fact${vehicle?.plate ? " mono" : ""}`}><Icon name="car" size={13} />{vehicle?.plate ?? "No plate"}</span>
          {header.tradeIn && <span className="chip-fact">Trade-in: {header.tradeIn.title}</span>}
        </div>
      </div>
    </header>

    <div className="case-story">
      <p className={`story-headline tone-${items.length ? story.tone : "ok"}`}>{story.headline}</p>
      <p className="story-detail">{story.intro} {story.detail}</p>
    </div>

    <div className="case-grid">
      <div className="case-main">
        <section aria-labelledby="needs-head">
          <SectionHead title="Needs you" count={items.length} note={items.length ? "Most urgent first. Nothing is saved until you confirm." : undefined} />
          <h2 id="needs-head" className="sr-only">Needs you</h2>
          {items.length === 0 && <div className="nothing"><Icon name="check" /><span>Nothing on this order is waiting on a person.
            <small>Checked: alerts, incidents, work items, conversations, agent proposals, claims, custody, the pickup contact of a booked car and a moving car's position. A quiet order is not the same as a verified one.</small></span></div>}
          {items.slice(0, 1).map((item) => <DecisionCard key={`${item.kind}-${item.recordId}`} item={item} orderId={detail.order.id} snapshotAt={view.snapshotAt} showNext={showNext[0]} onDecided={onChange} />)}
          {items.length > 1 && <>
            <p className="sub also-head">Also open on this order <span className="num">{items.length - 1}</span></p>
            {items.slice(1).map((item, index) => <DecisionCard key={`${item.kind}-${item.recordId}`} item={item} orderId={detail.order.id} snapshotAt={view.snapshotAt} showNext={showNext[index + 1]} onDecided={onChange} compact />)}
          </>}
          {detail.case.decided.length > 0 && <>
            <p className="sub" style={{ marginTop: 22 }}>Decided</p>
            {detail.case.decided.map((entry) => <DoneCard key={entry.decision.id} entry={entry} onUndone={onChange} />)}
          </>}
        </section>

        <section aria-label="What happened">
          <SectionHead title="What happened" count={detail.case.timeline.length} note="Messages, agent work, decisions and recorded events, newest first." />
          <Timeline entries={detail.case.timeline} />
        </section>

        <RouteStrip view={view} />
        <EvidenceSection view={view} />
      </div>

      <aside className="case-side" aria-label="The facts">
        <FactsPanel groups={detail.case.facts} />
      </aside>
    </div>

    <RecordsPanel view={view} orderId={detail.order.id} />
  </>
}

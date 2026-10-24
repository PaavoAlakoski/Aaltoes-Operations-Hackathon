"use client"

import type { Certainty, FactGroup } from "@/lib/present/case"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "../icons"

const CERT_LABEL: Record<Certainty, string> = { confirmed: "Confirmed", stated: "Stated", planned: "Planned", quoted: "Quote", missing: "Missing" }

/** The few facts a decision rests on, each with how sure it is and who said so. */
export function FactsPanel({ groups }: { groups: FactGroup[] }) {
  return <>
    {groups.map((group) => <section className="facts-card" key={group.title} aria-label={group.title}>
      <h3><Icon name={group.icon} size={14} />{group.title}</h3>
      {group.rows.map((row) => <div className="pfact" key={`${row.label}-${row.value}`}>
        <div className="pfact-top">
          <span className="pfact-label">{row.label}</span>
          <span className={`cert cert-${row.certainty}`}>{CERT_LABEL[row.certainty]}</span>
        </div>
        <div className={`pfact-value tone-${row.tone}`}>{row.value}</div>
        <div className="pfact-src">{row.source}{row.at ? ` · ${fmtDateTime(row.at)}` : ""}</div>
      </div>)}
    </section>)}
    <p className="cert-legend"><b>Confirmed</b> rests on a recorded reply, booking or physical event. <b>Stated</b> is what someone said or a standard profile. <b>Planned</b> and <b>Quote</b> have not happened yet.</p>
  </>
}

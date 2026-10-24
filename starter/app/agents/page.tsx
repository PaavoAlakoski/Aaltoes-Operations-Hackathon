"use client"

import { useEffect, useState } from "react"
import { type AgentsView, type Level, LEVELS } from "@/lib/present/autonomy"
import { AppFrame } from "../components/app-frame"
import { Icon } from "../components/icons"

export default function AgentsPage() {
  const [view, setView] = useState<AgentsView | null>(null)
  const [error, setError] = useState("")
  const [saving, setSaving] = useState<string | null>(null)

  function load() {
    fetch("/api/agents", { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("Could not load the agent settings"); return response.json() as Promise<AgentsView> })
      .then((data) => { setView(data); setError("") })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load the agent settings"))
  }
  useEffect(load, [])

  async function choose(key: string, level: Level) {
    setSaving(key)
    const response = await fetch("/api/agents", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, level }) })
    if (!response.ok) setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save")
    setSaving(null)
    load()
  }

  return <AppFrame section="agents"><main className="qpage">
    <div className="qhead"><div>
      <h1>What agents may do</h1>
      <p className="qsummary">Agents do the legwork; people make the judgement calls. Everything starts at “ask first” and gets more freedom as an agent earns trust.</p>
    </div></div>
    {error && <p className="qerror" role="alert">{error}</p>}
    {!view && !error && <div aria-busy="true">{[0, 1, 2].map((index) => <div className="qskeleton" key={index} />)}</div>}
    {view && <>
      <section className="qgroup">
        <div className="qgroup-head"><h2>The agents</h2><span className="num">{view.agents.length}</span><p>Their record: what they proposed and what people did with it.</p></div>
        <div className="agents-grid">{view.agents.map((agent) => <article className="agent-card" key={agent.id}>
          <h3><Icon name="bot" />{agent.title}</h3>
          <p>{agent.scope}</p>
          <div className="agent-record">
            {agent.proposed === 0 && <span className="chip tone-neutral">No proposals in this snapshot</span>}
            {agent.approved > 0 && <span className="chip tone-ok">{agent.approved} approved</span>}
            {agent.changed > 0 && <span className="chip tone-neutral">{agent.changed} changed by a person</span>}
            {agent.rejected > 0 && <span className="chip tone-neutral">{agent.rejected} rejected</span>}
            {agent.failed > 0 && <span className="chip tone-danger">{agent.failed} failed</span>}
            {agent.waiting > 0 && <span className="chip tone-accent">{agent.waiting} waiting for a yes</span>}
          </div>
        </article>)}</div>
      </section>

      <section className="qgroup" style={{ marginTop: 40 }}>
        <div className="qgroup-head"><h2>How much they may do alone</h2><p>Applies to every agent. A change here takes effect on the next proposal.</p></div>
        <div className="rules">{view.kinds.map((kind) => <div className="rule" key={kind.key}>
          <div>
            <div className="rule-name">{kind.name}</div>
            <div className="rule-text">{kind.text}</div>
          </div>
          {kind.locked
            ? <span className="rule-lock"><Icon name="key" size={14} />{LEVELS.find((level) => level.key === kind.level)?.label} · {kind.lockReason}</span>
            : <div className="segments" role="group" aria-label={kind.name}>{LEVELS.map((level) => <button type="button" key={level.key} className="segment" title={level.hint}
                aria-pressed={kind.level === level.key} disabled={saving === kind.key} onClick={() => choose(kind.key, level.key)}>{level.label}</button>)}</div>}
        </div>)}</div>
        <p className="note-text">“Ask first” brings you a proposal with its evidence and what it would change. “Act, then tell” posts what it did on the order so you can undo it. Nothing in this prototype reaches a real driver, site or customer.</p>
      </section>
    </>}
  </main></AppFrame>
}

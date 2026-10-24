"use client"

import Link from "next/link"
import { use, useCallback, useEffect, useState } from "react"
import { AppFrame } from "../../components/app-frame"
import { OrderPane, type Detail } from "../../components/order-detail"

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")

  const load = useCallback((signal?: AbortSignal) => {
    fetch(`/api/orders/${encodeURIComponent(id)}`, { signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error(response.status === 404 ? "Order not found" : "Could not load order"); return response.json() as Promise<Detail> })
      .then((data) => { setDetail(data); setError("") })
      .catch((cause: unknown) => { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Could not load order") })
  }, [id])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (detail) document.title = `${detail.view.header.reference} · ${detail.view.header.vehicle?.title ?? "Order"} · Control Room`
  }, [detail])

  return <AppFrame section="queue" snapshotAt={detail?.view.snapshotAt ?? null}><main className="case">
    <nav className="crumbs" aria-label="Breadcrumb"><Link href="/">Needs you</Link><span>/</span><span>{detail?.view.header.reference ?? "Order"}</span></nav>
    {error && <div className="record-state" role="alert"><h1>{error}</h1><p>The order could not be opened. <Link href="/">Back to the queue</Link></p></div>}
    {!error && !detail && <div className="record-state" aria-busy="true">
      <div className="qskeleton" style={{ height: 104 }} />
      <div className="qskeleton" style={{ height: 180, marginTop: 24 }} />
      <div className="qskeleton" style={{ height: 180 }} />
    </div>}
    {detail && <OrderPane detail={detail} onChange={() => load()} />}
  </main></AppFrame>
}

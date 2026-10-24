import Link from "next/link"
import type { ReactNode } from "react"
import { fmtDateTime } from "@/lib/present/time"
import { Icon } from "./icons"

export type Section = "queue" | "board" | "inbox" | "customers" | "drivers" | "sites" | "agents"

const GROUPS: { label: string; links: { section: Section; href: string; label: string; icon: string }[] }[] = [
  { label: "Work", links: [
    { section: "queue", href: "/", label: "Needs you", icon: "flag" },
    { section: "board", href: "/orders", label: "All orders", icon: "car" },
    { section: "inbox", href: "/inbox", label: "Inbox", icon: "inbox" },
  ] },
  { label: "People and places", links: [
    { section: "customers", href: "/customers", label: "Customers", icon: "people" },
    { section: "drivers", href: "/drivers", label: "Drivers", icon: "driver" },
    { section: "sites", href: "/sites", label: "Places", icon: "building" },
  ] },
  { label: "Agents", links: [
    { section: "agents", href: "/agents", label: "What agents may do", icon: "bot" },
  ] },
]

export function AppFrame({ children, section, snapshotAt, board = false, count }: { children: ReactNode; section: Section; snapshotAt?: string | null; board?: boolean; count?: number | null }) {
  return <div className={`app${board ? " app-board" : ""}`}>
    <aside className="sidebar">
      <Link href="/" className="wordmark" aria-label="Control Room home"><span className="wordmark-mark" aria-hidden="true">b</span>Control Room</Link>
      <nav className="sidebar-nav" aria-label="Main navigation">
        {GROUPS.map((group) => <div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.links.map((link) => <Link key={link.section} href={link.href} className={`nav-link${section === link.section ? " active" : ""}`} aria-current={section === link.section ? "page" : undefined}>
            <Icon name={link.icon} size={15} />{link.label}
            {link.section === "queue" && count != null && count > 0 && <span className="nav-count num">{count}</span>}
          </Link>)}
        </div>)}
      </nav>
      <div className="sidebar-foot">{snapshotAt ? `Snapshot ${fmtDateTime(snapshotAt)}` : "Fictional snapshot"}<br />Fictional data · nothing real is contacted</div>
    </aside>
    <div className="main">{children}</div>
  </div>
}

// The frame around every signed-in screen: sidebar, verification banner, content.
import { useState } from "react"
import { Link, NavLink, Outlet } from "react-router"
import { Brand, Icon } from "../shared/ui/common"
import { useMe, useSession } from "./session"

export function Layout() {
  const { me, org, config, isAdmin } = useMe()
  const { signOut } = useSession()
  const [navOpen, setNavOpen] = useState(false)
  const nav: Array<[string, string, string]> = [
    ["/documents", "Documents", "docs"],
    ["/templates", "Templates", "tmpl"],
    ["/users", "People", "users"],
    ["/settings", "Settings", "settings"],
  ]
  if (isAdmin) nav.push(["/audit", "Activity log", "audit"])

  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar">
        <Brand appName={config.appName} />
        <div className="org-name" title={org.name}>
          {org.name}
        </div>
        <nav className="nav">
          {nav.map(([to, label, icon]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")} onClick={() => setNavOpen(false)}>
              <Icon name={icon} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="me">
          <div style={{ fontWeight: 600 }}>{me.name}</div>
          <div className="muted">
            {me.email} · {me.role}
          </div>
          <button className="btn small ghost" style={{ marginTop: 6, padding: 0 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <div>
        <div className="mobile-bar">
          <button className="btn ghost small" aria-label="Menu" onClick={() => setNavOpen((o) => !o)}>
            <Icon name="menu" />
          </button>
          <Brand appName={config.appName} />
        </div>
        <main className="content">
          <VerificationBanner />
          <Outlet />
        </main>
      </div>
    </div>
  )
}

// Until platform staff verify the company, nothing can be issued. Say so everywhere.
function VerificationBanner() {
  const { org, isAdmin } = useMe()
  const v = org.verification
  if (!v || v.status === "verified") return null
  const toSettings = (text: string) => (isAdmin ? <Link to="/settings">{text}</Link> : null)
  const byStatus: Record<string, [string, string, React.ReactNode]> = {
    unverified: [
      "warn",
      "Your company isn't verified yet, so documents can't be issued. ",
      isAdmin ? toSettings("Go to verification") : "Ask an admin to request verification in Settings.",
    ],
    pending: [
      "info",
      "Verification requested — we're checking your company's details. You can prepare documents, but they can't be issued yet. ",
      !v.domainVerified ? toSettings("Add your DNS record to speed this up") : null,
    ],
    rejected: ["bad", `Verification wasn't approved: ${v.note || "no reason given"}. `, toSettings("Correct your details")],
    suspended: [
      "bad",
      `Your company has been suspended: ${v.note || "no reason given"}. Documents can't be issued, and documents already issued show as not valid. Contact support.`,
      null,
    ],
  }
  const [cls, text, extra] = byStatus[v.status] || byStatus.unverified
  return (
    <div className={`notice ${cls}`} role="status" style={{ marginBottom: 16 }}>
      {text}
      {extra}
    </div>
  )
}

// URLs under /platform.
import type { ReactNode } from "react"
import { Navigate, NavLink, Outlet, Route, Routes } from "react-router"
import { useState } from "react"
import { useStaffSession } from "./session"
import { Brand, Icon } from "../shared/ui/common"
import { Login, Setup } from "./pages/Auth"
import { Overview } from "./pages/Overview"
import { Companies } from "./pages/Companies"
import { Company } from "./pages/Company"
import { Activity } from "./pages/Activity"

export function PlatformApp() {
  const { ready } = useStaffSession()
  if (!ready) return <p className="loading" style={{ padding: 24 }}>Loading…</p>
  return (
    <Routes>
      <Route path="login" element={<Login />} />
      <Route path="setup" element={<NeedsSetup><Setup /></NeedsSetup>} />
      <Route element={<SignedIn><Layout /></SignedIn>}>
        <Route index element={<Navigate to="/overview" replace />} />
        <Route path="overview" element={<Overview />} />
        <Route path="companies" element={<Companies />} />
        <Route path="companies/:id" element={<Company />} />
        <Route path="activity" element={<Activity />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  )
}

function SignedIn({ children }: { children: ReactNode }) {
  const { staff, setupRequired } = useStaffSession()
  if (!staff) return <Navigate to="/login" replace />
  if (setupRequired) return <Navigate to="/setup" replace />
  return <>{children}</>
}

function NeedsSetup({ children }: { children: ReactNode }) {
  const { staff, setupRequired } = useStaffSession()
  if (!staff) return <Navigate to="/login" replace />
  if (!setupRequired) return <Navigate to="/overview" replace />
  return <>{children}</>
}

function Layout() {
  const { staff, appName, signOut } = useStaffSession()
  const [navOpen, setNavOpen] = useState(false)
  const nav: Array<[string, string, string]> = [["/overview", "Overview", "overview"], ["/companies", "Companies", "companies"], ["/activity", "Activity log", "audit"]]
  return (
    <div className={`app${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar">
        <Brand appName={appName} href="/platform/overview" />
        <div className="org-name">Platform staff</div>
        <nav className="nav">
          {nav.map(([to, label, icon]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")} onClick={() => setNavOpen(false)}>
              <Icon name={icon} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="me">
          <div style={{ fontWeight: 600 }}>{staff!.name}</div>
          <div className="muted">{staff!.email}</div>
          <button className="btn small ghost" style={{ marginTop: 6, padding: 0 }} onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <div>
        <div className="mobile-bar">
          <button className="btn ghost small" aria-label="Menu" onClick={() => setNavOpen((o) => !o)}><Icon name="menu" /></button>
          <Brand appName={appName} href="/platform/overview" />
        </div>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  )
}

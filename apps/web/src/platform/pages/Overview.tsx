// Companies waiting for review, and signs something is wrong.
import { Link } from "react-router"
import { useQuery } from "@tanstack/react-query"
import type { PlatformOverview } from "@doctrust/shared"
import { api } from "../api"
import { fmtDate, fmtDay } from "../../shared/format"
import { Loading, PageError, PageHead } from "../../shared/ui/common"
import { CompanyTable, DomainCell, NameCell, StatusBadge } from "./parts"

function Stat({ num, label, to, cls }: { num: number; label: string; to?: string; cls?: string }) {
  const body = <><div className="num">{num.toLocaleString()}</div><div className="label">{label}</div></>
  return to ? <Link className={`stat ${cls || ""}`} to={to}>{body}</Link> : <div className={`stat ${cls || ""}`}>{body}</div>
}

export function Overview() {
  const q = useQuery({ queryKey: ["overview"], queryFn: () => api<PlatformOverview>("GET", "/overview") })
  if (q.error) return <PageError error={q.error} back={{ href: "/platform/overview", label: "Back to overview" }} />
  if (!q.data) return <Loading />
  const { stats, pending, flagged } = q.data
  const c = stats.companies
  return (
    <>
      <PageHead title="Overview" sub="Companies waiting for review, and signs something is wrong." />
      <div className="stack">
        <div className="stat-grid">
          <Stat num={c.pending} label="Waiting for review" to="/companies?status=pending" cls={c.pending ? "attention" : ""} />
          <Stat num={c.verified} label="Verified companies" to="/companies?status=verified" />
          <Stat num={c.unverified + c.rejected} label="Not verified" to="/companies?status=unverified" />
          <Stat num={c.suspended} label="Suspended" to="/companies?status=suspended" cls={c.suspended ? "alert" : ""} />
          <Stat num={stats.documents.issued30} label="Documents issued (30 days)" />
          <Stat num={stats.scans.scans30} label="QR scans (30 days)" />
          <Stat num={stats.scans.invalid30} label="Scans of invalid documents (30 days)" to="/companies?sort=invalid" cls={stats.scans.invalid30 ? "alert" : ""} />
        </div>
        <section className="stack">
          <h2>Waiting for review</h2>
          {pending.length ? (
            <CompanyTable rows={pending} columns={[
              ["Company", (x) => <NameCell c={x} />],
              ["Domain", (x) => <DomainCell c={x} />],
              ["Requested", (x) => fmtDate(x.requestedAt, "—"), "nowrap"],
              ["Signed up", (x) => fmtDay(x.createdAt), "nowrap"],
            ]} />
          ) : <div className="card empty">Nothing waiting. 🎉</div>}
        </section>
        <section className="stack">
          <h2>Invalid documents being presented</h2>
          <p className="muted">Partners scanned these companies' documents and got anything other than "Valid" — tampered, revoked, replaced, or from an unverified issuer. A spike can mean someone is using forged or cancelled documents.</p>
          {flagged.length ? (
            <CompanyTable rows={flagged} columns={[
              ["Company", (x) => <NameCell c={x} />],
              ["Status", (x) => <StatusBadge status={x.status} />],
              ["Invalid scans", (x) => <strong style={{ color: "var(--bad)" }}>{x.invalid30}</strong>, "num-cell"],
              ["All scans", (x) => x.scans30, "num-cell"],
            ]} />
          ) : <div className="card empty">No invalid scans in the last 30 days.</div>}
        </section>
      </div>
    </>
  )
}

// All companies: filter by status, search, sort by invalid scans.
import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "react-router"
import type { CompanyRow } from "@doctrust/shared"
import { api } from "../api"
import { fmtDay } from "../../shared/format"
import { Loading, PageError, PageHead } from "../../shared/ui/common"
import { CompanyTable, DomainCell, NameCell, StatusBadge } from "./parts"

const TABS: Array<[string, string]> = [["", "All"], ["pending", "Waiting for review"], ["verified", "Verified"], ["unverified", "Not applied"], ["rejected", "Rejected"], ["suspended", "Suspended"]]

export function Companies() {
  const [params, setParams] = useSearchParams()
  const status = params.get("status") || ""
  const q = params.get("q") || ""
  const sort = params.get("sort") || ""
  const list = useQuery({
    queryKey: ["companies", status, q, sort],
    queryFn: async () => (await api<{ companies: CompanyRow[] }>("GET", `/companies?${new URLSearchParams({ status, q, sort })}`)).companies,
  })
  const go = (over: Record<string, string>) => setParams(new URLSearchParams({ status, q, sort, ...over }))
  if (list.error) return <PageError error={list.error} back={{ href: "/platform/overview", label: "Back to overview" }} />
  if (!list.data) return <Loading />
  const companies = list.data
  return (
    <>
      <PageHead title="Companies" sub={`${companies.length}${companies.length === 200 ? "+" : ""} shown`} />
      <div className="tabs">
        {TABS.map(([s, label]) => <button key={s || "all"} className={s === status ? "active" : ""} onClick={() => go({ status: s })}>{label}</button>)}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Search name, ID, domain, registration no.…" defaultValue={q} style={{ maxWidth: 360 }} onKeyDown={(e) => {
          if (e.key === "Enter") go({ q: e.currentTarget.value })
        }} />
        <label className="check" style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={sort === "invalid"} onChange={(e) => go({ sort: e.target.checked ? "invalid" : "" })} />
          Most invalid scans first
        </label>
      </div>
      {companies.length ? (
        <CompanyTable rows={companies} columns={[
          ["Company", (c) => <NameCell c={c} />],
          ["Status", (c) => <StatusBadge status={c.status} />],
          ["Domain", (c) => <DomainCell c={c} />],
          ["People", (c) => c.users, "num-cell"],
          ["Issued", (c) => c.issued, "num-cell"],
          ["Invalid scans (30d)", (c) => (c.invalid30 ? <strong style={{ color: "var(--bad)" }}>{c.invalid30}</strong> : "0"), "num-cell"],
          ["Signed up", (c) => fmtDay(c.createdAt), "nowrap"],
        ]} />
      ) : <div className="card empty">No companies match.</div>}
    </>
  )
}

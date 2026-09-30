// Staff sign-ins and every verification request and decision.
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router"
import type { PlatformActivityEvent } from "@doctrust/shared"
import { api } from "../api"
import { detailText, fmtDate } from "../../shared/format"
import { Loading, PageError, PageHead } from "../../shared/ui/common"

export function Activity() {
  const q = useQuery({ queryKey: ["activity"], queryFn: async () => (await api<{ events: PlatformActivityEvent[] }>("GET", "/activity?limit=300")).events })
  if (q.error) return <PageError error={q.error} back={{ href: "/platform/overview", label: "Back to overview" }} />
  if (!q.data) return <Loading />
  return (
    <>
      <PageHead title="Activity log" sub="Staff sign-ins and every verification request and decision, newest first." />
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Company</th><th>Details</th></tr></thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(e.createdAt, "—")}</td>
                <td>{e.who}</td>
                <td>{e.action}</td>
                <td>{e.organizationId ? <Link to={`/companies/${e.organizationId}`}>{e.organizationName || "—"}</Link> : "—"}</td>
                <td className="muted" style={{ fontSize: ".85rem", maxWidth: 360, overflowWrap: "anywhere" }}>
                  {[detailText(e.details, ["staffId", "staff"]), e.ip ? ` · ip: ${e.ip}` : ""].join("")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// The company's activity log.
import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router"
import type { AuditEvent } from "@doctrust/shared"
import { api } from "../api"
import { detailText, fmtDate } from "../../shared/format"
import { Loading, PageError, PageHead } from "../../shared/ui/common"

export function Activity() {
  const events = useQuery({ queryKey: ["audit"], queryFn: async () => (await api<{ events: AuditEvent[] }>("GET", "/api/audit?limit=300")).events })
  if (events.error) return <PageError error={events.error} back={{ href: "/app/documents", label: "Back to documents" }} />
  if (!events.data) return <Loading />
  return (
    <>
      <PageHead title="Activity log" sub="Everything that happened in your account, newest first. Entries can't be edited." />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr>
          </thead>
          <tbody>
            {events.data.map((e) => (
              <tr key={e.id}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(e.createdAt)}</td>
                <td>{e.userName || "—"}</td>
                <td>{e.entityType === "document" && e.entityId ? <Link to={`/documents/${e.entityId}`}>{e.action}</Link> : e.action}</td>
                <td className="muted" style={{ fontSize: ".85rem", maxWidth: 380, overflowWrap: "anywhere" }}>{detailText(e.details)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

// The documents list: tabs by status, search, and "New document".
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate, useSearchParams } from "react-router"
import type { DocumentList, DocumentStatus } from "@doctrust/shared"
import { api } from "../api"
import { useMe } from "../session"
import { useTemplates } from "../queries"
import { fmtDate } from "../../shared/format"
import { Badge, Loading, PageError, PageHead, STATUS_LABEL } from "../../shared/ui/common"
import { useDialogs } from "../../shared/ui/Dialogs"

export function Documents() {
  const { isAdmin } = useMe()
  const navigate = useNavigate()
  const dialogs = useDialogs()
  const [params, setParams] = useSearchParams()
  const status = params.get("status") || ""
  const q = params.get("q") || ""
  const list = useQuery({
    queryKey: ["documents", status, q],
    queryFn: () => api<DocumentList>("GET", `/api/documents?${new URLSearchParams({ status, q, limit: "100" })}`),
  })
  const templates = useTemplates()

  if (list.error || templates.error) return <PageError error={list.error || templates.error} back={{ href: "/app/templates", label: "Templates" }} />
  if (!list.data || !templates.data) return <Loading />

  const tmplName = new Map(templates.data.map((t) => [t.id, t.name]))
  const active = templates.data.filter((t) => !t.archived)
  const counts = list.data.counts
  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0)
  const go = (next: { status?: string; q?: string }) => setParams(new URLSearchParams({ status, q, ...next }))

  const newDocument = async () => {
    if (active.length === 1) return navigate(`/documents/new/${active[0].id}`)
    const picked = await dialogs.form("New document", (
      <label className="field">
        <span>Template</span>
        <select name="templateId">
          {active.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
    ), { submitLabel: "Continue" })
    if (picked) navigate(`/documents/new/${picked.templateId}`)
  }

  const tabs = ([["", "All", total], ...(Object.keys(STATUS_LABEL) as DocumentStatus[]).map((s) => [s, STATUS_LABEL[s], counts[s] || 0])] as Array<[string, string, number]>)
    .filter(([s, , n]) => s === "" || n > 0 || s === status)

  let body
  if (templates.data.length === 0) {
    body = (
      <div className="card empty">
        <h2>Add your first template</h2>
        <p>Templates are your certificate and report layouts. Add one, then you can start issuing documents.</p>
        {isAdmin ? <Link className="btn primary" to="/templates/add">Add a template</Link> : <p>Ask an admin to add one.</p>}
      </div>
    )
  } else if (list.data.documents.length === 0) {
    body = <div className="card empty">{q || status ? "No documents match." : "No documents yet."}</div>
  } else {
    body = (
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>Template</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {list.data.documents.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => navigate(`/documents/${d.id}`)}>
                <td>
                  <Link to={`/documents/${d.id}`} style={{ fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>
                    {d.documentNo}
                  </Link>
                </td>
                <td>{tmplName.get(d.templateId) || "—"}</td>
                <td><Badge status={d.status} /></td>
                <td className="muted">{fmtDate(d.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <>
      <PageHead title="Documents" sub={`${total} total`} actions={<button className="btn primary" disabled={active.length === 0} onClick={newDocument}>New document</button>} />
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="tabs" role="tablist">
          {tabs.map(([s, label, n]) => (
            <button key={s || "all"} className={s === status ? "active" : ""} onClick={() => go({ status: s })}>
              {label}
              <span className="count">{n}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <input
          type="search"
          placeholder="Search number, company, item…"
          defaultValue={q}
          style={{ maxWidth: 320 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") go({ q: e.currentTarget.value })
          }}
        />
      </div>
      {body}
      {list.data.total > list.data.documents.length ? (
        <p className="muted" style={{ marginTop: 10 }}>
          Showing {list.data.documents.length} of {list.data.total}. Search to narrow down.
        </p>
      ) : null}
    </>
  )
}

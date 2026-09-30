// Templates: the list, choosing how to add one, and opening one in the right editor.
import { Link, useParams } from "react-router"
import { useQuery } from "@tanstack/react-query"
import type { TemplateDetail } from "@doctrust/shared"
import { api } from "../api"
import { useMe } from "../session"
import { useTemplates } from "../queries"
import { Loading, PageError, PageHead } from "../../shared/ui/common"
import { HtmlTemplateEditor } from "./HtmlTemplateEditor"
import { PdfTemplateEditor } from "../pdf-editor/PdfTemplateEditor"

export function Templates() {
  const { isAdmin } = useMe()
  const templates = useTemplates()
  if (templates.error) return <PageError error={templates.error} back={{ href: "/app/documents", label: "Back to documents" }} />
  if (!templates.data) return <Loading />
  return (
    <>
      <PageHead
        title="Templates"
        sub="Your document layouts and the fields each one needs."
        actions={isAdmin ? <Link className="btn primary" to="/templates/add">Add template</Link> : null}
      />
      {templates.data.length ? (
        <div className="cards">
          {templates.data.map((t) => (
            <div key={t.id} className="tile">
              <div className="row">
                <h3>{t.name}</h3>
                {t.archived ? <span className="badge">Archived</span> : null}
              </div>
              <p className="muted" style={{ margin: 0, fontSize: ".9rem" }}>{t.description || "No description"}</p>
              <div className="muted" style={{ fontSize: ".8rem" }}>
                Version {t.currentVersion ? t.currentVersion.version : "—"} · {t.currentVersion?.schema.length || 0} fields
              </div>
              <div className="row" style={{ marginTop: "auto", paddingTop: 8 }}>
                {!t.archived ? <Link className="btn small primary" to={`/documents/new/${t.id}`}>New document</Link> : null}
                <Link className="btn small" to={`/templates/${t.id}`}>{isAdmin ? "Edit" : "View"}</Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card empty">No templates yet.</div>
      )}
    </>
  )
}

export function TemplateChooser() {
  return (
    <>
      <PageHead title="Add a template" sub="How would you like to create it?" />
      <div className="cards chooser">
        <Link className="tile choice" to="/templates/new-pdf">
          <span className="badge issued" style={{ alignSelf: "flex-start" }}>Recommended</span>
          <h3>Upload your PDF form</h3>
          <p className="muted">Use the form you already have. Draw boxes where the information goes — your design stays exactly the same.</p>
          <span className="btn primary" style={{ marginTop: "auto", alignSelf: "flex-start" }}>Upload PDF</span>
        </Link>
        <Link className="tile choice" to="/templates/new">
          <h3>Design with HTML</h3>
          <p className="muted">For developers: write the layout as HTML with placeholders. Best for documents with long, variable tables.</p>
          <span className="btn" style={{ marginTop: "auto", alignSelf: "flex-start" }}>Start from an example</span>
        </Link>
      </div>
    </>
  )
}

// /templates/:id — the PDF form editor or the HTML editor, depending on the template.
export function TemplateRoute() {
  const { id = "" } = useParams()
  const detail = useQuery({ queryKey: ["template", id], queryFn: () => api<TemplateDetail>("GET", `/api/templates/${id}`) })
  if (detail.error) return <PageError error={detail.error} back={{ href: "/app/templates", label: "Back to templates" }} />
  if (!detail.data) return <Loading />
  // A new version re-mounts the editor with the saved content.
  const key = `${id}:${detail.data.version.id}:${detail.data.template.archived}`
  return detail.data.version.kind === "pdf"
    ? <PdfTemplateEditor key={key} id={id} loaded={detail.data} />
    : <HtmlTemplateEditor key={key} id={id} loaded={detail.data} />
}

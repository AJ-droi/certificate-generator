// One document: edit (drafts), submit, approve, send back, revoke, correct,
// download the official PDF, and its verification link and history.
import { useState, type ReactNode } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { DocumentData, DocumentDetail, DocumentRecord, RenderResult } from "@doctrust/shared"
import { api } from "../api"
import { NOT_VERIFIED_TITLE, useMe } from "../session"
import { DocumentForm } from "../components/DocumentForm"
import { fmtDate } from "../../shared/format"
import { errorMessage } from "../../shared/api"
import { AsyncButton } from "../../shared/ui/AsyncButton"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { Badge, Loading, PageError, PageHead } from "../../shared/ui/common"
import { PreviewFrame } from "../../shared/ui/PreviewFrame"
import { useDialogs } from "../../shared/ui/Dialogs"
import { useToast } from "../../shared/ui/Toasts"

export function DocumentPage() {
  const { id = "" } = useParams()
  const detail = useQuery({
    queryKey: ["document", id],
    queryFn: () => api<DocumentDetail>("GET", `/api/documents/${id}`),
    // The official PDF is made in the background: check again until it's ready.
    refetchInterval: (query) => (query.state.data?.document.pdfStatus === "pending" ? 3000 : false),
  })
  if (detail.error) return <PageError error={detail.error} back={{ href: "/app/documents", label: "Back to documents" }} />
  if (!detail.data) return <Loading />
  // Re-mount when the document changes state, so the editor starts from the saved values.
  return <DocumentView key={`${id}:${detail.data.document.status}`} detail={detail.data} />
}

function DocumentView({ detail }: { detail: DocumentDetail }) {
  const { document: doc, template, version, related, people, history, verifyUrl } = detail
  const { me, org, isAdmin, canApprove, orgVerified } = useMe()
  const navigate = useNavigate()
  const queries = useQueryClient()
  const dialogs = useDialogs()
  const toast = useToast()
  const mine = doc.createdBy === me.id
  const editable = doc.status === "draft" && (mine || isAdmin)
  const [values, setValues] = useState<DocumentData>(doc.data)
  const [documentNo, setDocumentNo] = useState(doc.documentNo)
  const [error, setError] = useState<unknown>(null)
  const preview = useQuery({
    queryKey: ["document-preview", doc.id],
    queryFn: () => api<RenderResult>("GET", `/api/documents/${doc.id}/render`),
    staleTime: Infinity,
    gcTime: 0,
  })
  const loadPreview = () => preview.refetch()

  const refresh = (nextId = doc.id) => {
    queries.invalidateQueries({ queryKey: ["documents"] })
    queries.invalidateQueries({ queryKey: ["document", doc.id] })
    if (nextId !== doc.id) navigate(`/documents/${nextId}`)
  }
  const saveDraft = () => api("PATCH", `/api/documents/${doc.id}`, { data: values, documentNo: documentNo.trim() })

  // A button that (optionally) asks for confirmation, then posts an action.
  const action = (label: string, path: string, opts: { cls?: string; done?: string; disabledTitle?: string; confirm?: { title: string; body: ReactNode; submit: string; danger?: boolean } } = {}) => (
    <AsyncButton
      key={path + label}
      className={`btn ${opts.cls || ""}`}
      disabled={Boolean(opts.disabledTitle)}
      title={opts.disabledTitle}
      onError={setError}
      onClick={async () => {
        let body = {}
        if (opts.confirm) {
          const answer = await dialogs.form(opts.confirm.title, opts.confirm.body, { submitLabel: opts.confirm.submit, danger: opts.confirm.danger })
          if (!answer) return
          body = answer
        }
        const out = await api<{ document: DocumentRecord }>("POST", `/api/documents/${doc.id}/${path}`, body)
        toast(opts.done || "Done")
        refresh(out.document.id)
      }}
    >
      {label}
    </AsyncButton>
  )

  // The official PDF is made in the background after issuing.
  const pdfAction = () => {
    if (doc.pdfStatus === "pending") {
      return <button key="pdf" className="btn" disabled title="The official PDF is being made">Preparing PDF…</button>
    }
    if (doc.pdfStatus === "failed") {
      return canApprove
        ? action("Try making the PDF again", "retry-pdf", { done: "Making the PDF again" })
        : <button key="pdf" className="btn" disabled title="Ask an approver to try again">PDF failed</button>
    }
    return <a key="pdf" className="btn" href={`/api/documents/${doc.id}/pdf`}>Download PDF</a>
  }

  const actions: ReactNode[] = []
  if (editable) {
    actions.push(
      <AsyncButton key="delete" className="btn danger" onError={setError} onClick={async () => {
        if (!(await dialogs.confirm("Delete this draft?", <p>This can't be undone.</p>, { submitLabel: "Delete", danger: true }))) return
        await api("DELETE", `/api/documents/${doc.id}`)
        toast("Draft deleted")
        queries.invalidateQueries({ queryKey: ["documents"] })
        navigate("/documents")
      }}>Delete</AsyncButton>,
      <AsyncButton key="save" onError={setError} onClick={async () => {
        await saveDraft()
        toast("Saved")
        await loadPreview()
      }}>Save</AsyncButton>,
      <AsyncButton key="submit" className="btn primary" onError={setError} onClick={async () => {
        await saveDraft()
        await api("POST", `/api/documents/${doc.id}/submit`, {})
        toast("Sent for approval")
        refresh()
      }}>Submit for approval</AsyncButton>,
    )
    if (!org.requireSeparateApprover && canApprove && mine) {
      actions.push(action("Approve & issue", "approve", {
        cls: "primary",
        done: "Issued",
        disabledTitle: orgVerified ? undefined : NOT_VERIFIED_TITLE,
        confirm: { title: "Issue this document?", body: <p>It will be signed, locked and given a QR code. After this, changes need a correction.</p>, submit: "Issue" },
      }))
    }
  }
  if (doc.status === "pending_approval" && canApprove) {
    const selfBlocked = org.requireSeparateApprover && mine
    actions.push(action("Send back", "send-back", {
      done: "Sent back to draft",
      confirm: {
        title: "Send back for changes",
        body: <label className="field"><span>What needs changing?</span><textarea name="note" rows={3} /></label>,
        submit: "Send back",
      },
    }))
    actions.push(action("Approve & issue", "approve", {
      cls: "primary",
      done: "Issued — signed and locked",
      disabledTitle: selfBlocked ? "Someone else must approve a document you prepared" : orgVerified ? undefined : NOT_VERIFIED_TITLE,
      confirm: { title: "Approve and issue?", body: <p>Your name and signature go on the document. It will be signed, locked and given a QR code that partners can check.</p>, submit: "Approve & issue" },
    }))
  }
  if (doc.status === "issued") {
    actions.push(pdfAction())
    if (!related.some((r) => r.supersedesId === doc.id)) actions.push(action("Start correction", "correct", { done: "Correction draft created" }))
    if (canApprove) {
      actions.push(action("Revoke", "revoke", {
        cls: "danger",
        done: "Revoked",
        confirm: {
          title: "Revoke this document?",
          body: (
            <>
              <p>Anyone who checks it will see it's no longer valid, with your reason.</p>
              <label className="field"><span>Reason (shown publicly)</span><textarea name="reason" rows={3} required /></label>
            </>
          ),
          submit: "Revoke",
          danger: true,
        },
      }))
    }
  }
  if ((doc.status === "revoked" || doc.status === "superseded") && doc.pdfPath) actions.push(pdfAction())

  const notice =
    doc.status === "pending_approval" && org.requireSeparateApprover && mine ? (
      <div className="notice info">Waiting for an approver. Someone other than you must approve documents you prepare.</div>
    ) : doc.status === "draft" && doc.reviewNote ? (
      <div className="notice warn"><strong>Sent back: </strong>{doc.reviewNote}</div>
    ) : doc.status === "draft" && !editable ? (
      <div className="notice info">This draft belongs to someone else. Only they or an admin can edit it.</div>
    ) : null

  const frame = (
    <>
      {preview.error ? <p className="error-box" role="alert">{errorMessage(preview.error)}</p> : null}
      <PreviewFrame title="Document preview" result={preview.data ?? null} />
    </>
  )
  const main = editable ? (
    <div className="stack">
      <div className="card">
        <label className="field" style={{ maxWidth: 420 }}>
          <span>Document number</span>
          <input value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} />
        </label>
      </div>
      <div className="card">
        <DocumentForm schema={version.schema} value={values} onChange={setValues} />
      </div>
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Preview</h3>
          <div className="spacer" />
          <AsyncButton className="btn small" onError={setError} onClick={async () => { await saveDraft(); await loadPreview() }}>
            Save &amp; refresh preview
          </AsyncButton>
        </div>
        {frame}
      </div>
    </div>
  ) : frame

  const scans = history.filter((e) => e.action === "document.verified").length

  return (
    <>
      <PageHead title={doc.documentNo} sub={<span className="row"><Badge status={doc.status} />{template.name}</span>} actions={actions} />
      <ErrorBox error={error} />
      {notice}
      <div className="doc-layout" style={{ marginTop: 12 }}>
        {main}
        <aside className="doc-side">
          <div className="card">
            <h3>Details</h3>
            <dl className="kv">
              <dt>Template</dt><dd>{template.name} (v{version.version})</dd>
              <dt>Prepared by</dt><dd>{people[doc.createdBy] || "—"}</dd>
              {doc.issuedAt ? <><dt>Issued</dt><dd>{fmtDate(doc.issuedAt)}</dd></> : null}
              {doc.issuedBy ? <><dt>Approved by</dt><dd>{people[doc.issuedBy] || "—"}</dd></> : null}
              {doc.revokedAt ? <><dt>Revoked</dt><dd>{fmtDate(doc.revokedAt)} — {doc.revokeReason}</dd></> : null}
            </dl>
            {related.length ? (
              <div className="stack" style={{ marginTop: 12, fontSize: ".9rem" }}>
                {related.map((r) => (
                  <div key={r.id}>
                    {r.id === doc.supersedesId ? "Corrects " : r.supersedesId === doc.id ? "Corrected by " : "Related: "}
                    <Link to={`/documents/${r.id}`}>{r.documentNo}</Link> <Badge status={r.status} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {verifyUrl ? (
            <div className="card">
              <h3>Verification</h3>
              <p className="muted" style={{ fontSize: ".9rem" }}>Partners scan the QR code or open this link to confirm the document is genuine.</p>
              <div className="mono" style={{ marginBottom: 10 }}>{verifyUrl}</div>
              <div className="row">
                <a className="btn small" href={verifyUrl} target="_blank" rel="noopener">Open verify page</a>
                <button className="btn small" onClick={() => navigator.clipboard.writeText(verifyUrl).then(() => toast("Link copied"))}>Copy link</button>
              </div>
              <dl className="kv" style={{ marginTop: 12, fontSize: ".8rem" }}>
                <dt>Content hash</dt><dd className="mono">{doc.contentHash}</dd>
                <dt>PDF hash</dt><dd className="mono">{doc.pdfHash}</dd>
              </dl>
            </div>
          ) : null}
          <div className="card">
            <h3>History</h3>
            <ul className="timeline">
              {history.filter((e) => e.action !== "document.verified").map((e) => (
                <li key={e.id}>
                  <time>{fmtDate(e.createdAt)}</time>
                  {`${e.action.replace("document.", "").replace(/_/g, " ")} · ${e.userName || ""}`}
                  {typeof e.details?.note === "string" && e.details.note ? <div className="muted">“{e.details.note}”</div> : null}
                </li>
              ))}
            </ul>
            {scans ? <p className="muted" style={{ margin: "10px 0 0", fontSize: ".85rem" }}>Checked by partners {scans} time{scans === 1 ? "" : "s"}</p> : null}
          </div>
        </aside>
      </div>
    </>
  )
}

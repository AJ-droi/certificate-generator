// A new document from a template: fill in the form, save a draft.
import { useState } from "react"
import { useNavigate, useParams } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { DocumentData, DocumentRecord, TemplateDetail } from "@doctrust/shared"
import { api } from "../api"
import { DocumentForm } from "../components/DocumentForm"
import { AsyncButton } from "../../shared/ui/AsyncButton"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { Loading, PageError, PageHead } from "../../shared/ui/common"
import { useToast } from "../../shared/ui/Toasts"

export function NewDocument() {
  const { templateId = "" } = useParams()
  const detail = useQuery({ queryKey: ["template", templateId], queryFn: () => api<TemplateDetail>("GET", `/api/templates/${templateId}`) })
  if (detail.error) return <PageError error={detail.error} back={{ href: "/app/documents", label: "Back to documents" }} />
  if (!detail.data) return <Loading />
  return <NewDocumentForm key={templateId} detail={detail.data} />
}

function NewDocumentForm({ detail }: { detail: TemplateDetail }) {
  const { template, version } = detail
  const navigate = useNavigate()
  const toast = useToast()
  const queries = useQueryClient()
  const [values, setValues] = useState<DocumentData>({})
  const [formKey, setFormKey] = useState(0)
  const [documentNo, setDocumentNo] = useState("")
  const [error, setError] = useState<unknown>(null)
  const sample = version.settings.sampleData || {}
  const hasSample = Object.values(sample).some((v) => v !== "" && v !== false && v !== null && !(Array.isArray(v) && !v.length))

  const save = async () => {
    const res = await api<{ document: DocumentRecord }>("POST", "/api/documents", { templateId: template.id, data: values, documentNo: documentNo.trim() || undefined })
    toast("Draft saved")
    queries.invalidateQueries({ queryKey: ["documents"] })
    navigate(`/documents/${res.document.id}`)
  }
  const saveButton = <AsyncButton className="btn primary" onClick={save} onError={setError}>Save draft</AsyncButton>
  const pattern = `${version.settings.numberPrefix || ""}${"#".repeat(version.settings.numberPadding || 4)}`

  return (
    <>
      <PageHead
        title={`New ${template.name}`}
        sub="Fill in the details and save a draft. Nothing is official until it's approved and issued."
        actions={
          <>
            {hasSample ? (
              <button className="btn" onClick={() => { setValues(JSON.parse(JSON.stringify(sample))); setFormKey((k) => k + 1) }}>
                Fill with sample data
              </button>
            ) : null}
            {saveButton}
          </>
        }
      />
      <div className="stack">
        <div className="card">
          <label className="field" style={{ maxWidth: 420 }}>
            <span>Document number</span>
            <input value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} placeholder={`Leave blank to number automatically (${pattern})`} />
          </label>
        </div>
        <div className="card">
          <DocumentForm key={formKey} schema={version.schema} value={values} onChange={setValues} />
        </div>
        <ErrorBox error={error} />
        <div className="row">
          <div className="spacer" />
          {saveButton}
        </div>
      </div>
    </>
  )
}

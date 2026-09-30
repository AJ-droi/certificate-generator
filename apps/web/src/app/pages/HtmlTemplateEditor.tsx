// HTML (Handlebars) template editor: layout, fields, sample data, settings, preview.
import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Field, RenderResult, SavedTemplate, TemplateDetail, TemplateSettings } from "@doctrust/shared"
import { api } from "../api"
import { useMe } from "../session"
import { FieldBuilder } from "../components/FieldBuilder"
import { fmtDate, readText } from "../../shared/format"
import { errorMessage } from "../../shared/api"
import { AsyncButton } from "../../shared/ui/AsyncButton"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { PageHead } from "../../shared/ui/common"
import { PreviewFrame } from "../../shared/ui/PreviewFrame"
import { useToast } from "../../shared/ui/Toasts"
import { createStore, useStore } from "../../shared/store"

const STARTER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: Arial, sans-serif; margin: 0; }
.page { width: 210mm; min-height: 297mm; padding: 18mm; box-sizing: border-box; position: relative; }
.head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #222; padding-bottom: 8px; }
.head img { height: 56px; }
.qr img { width: 90px; height: 90px; }
h1 { font-size: 22px; margin: 24px 0 8px; }
table { border-collapse: collapse; width: 100%; margin-top: 12px; }
td, th { border: 1px solid #333; padding: 6px; text-align: left; font-size: 12px; }
.sign { margin-top: 40px; display: flex; gap: 40px; }
.sign img { height: 48px; }
</style>
</head>
<body>
<div class="page">
<div class="head">
  {{#if org.logo}}<img src="{{org.logo}}" alt="">{{else}}<strong>{{org.name}}</strong>{{/if}}
  <div class="qr">{{#if qr}}<img src="{{qr}}" alt="QR"><div style="font:8px monospace">{{document.verificationCode}}</div>{{/if}}</div>
</div>
<h1>Certificate of Completion</h1>
<p>No. <strong>{{document.no}}</strong></p>
<p>This certifies that <strong>{{recipientName}}</strong> completed <strong>{{courseName}}</strong> on {{formatDate completedOn}}.</p>
<div class="sign">
  <div>{{#if preparedBy.signature}}<img src="{{preparedBy.signature}}" alt="">{{/if}}<div>{{preparedBy.name}}</div><small>Prepared by</small></div>
  <div>{{#if approvedBy}}{{#if approvedBy.signature}}<img src="{{approvedBy.signature}}" alt="">{{/if}}<div>{{approvedBy.name}}</div>{{else}}<div style="height:48px"></div><div>—</div>{{/if}}<small>Approved by</small></div>
</div>
</div>
</body>
</html>`

const STARTER_SCHEMA: Field[] = [
  { key: "recipientName", label: "Recipient name", type: "text", required: true, showOnVerify: true },
  { key: "courseName", label: "Course", type: "text", required: true, showOnVerify: true },
  { key: "completedOn", label: "Completed on", type: "date", required: true, showOnVerify: true },
]

const HELPERS = ["formatDate", "check", "yesno", "upper", "default", "inc", "add", "mul", "length", "eq", "ne", "and", "or", "not"]
type Tab = "Layout" | "Fields" | "Sample data" | "Settings"

interface Model {
  name: string
  description: string
  html: string
  schema: Field[]
  settings: TemplateSettings
}

export function HtmlTemplateEditor({ id, loaded }: { id?: string; loaded?: TemplateDetail }) {
  const { isAdmin } = useMe()
  const navigate = useNavigate()
  const queries = useQueryClient()
  const toast = useToast()
  const isNew = !id
  const readOnly = !isAdmin
  const template = loaded?.template
  const version = loaded?.version

  const [store] = useState(() => createStore<Model>({
    name: template?.name ?? "",
    description: template?.description ?? "",
    html: version?.html ?? STARTER_HTML,
    schema: JSON.parse(JSON.stringify(version?.schema ?? STARTER_SCHEMA)),
    settings: version
      ? { ...version.settings }
      : { numberPrefix: "CERT-", numberPadding: 4, sampleData: { recipientName: "Jane Doe", courseName: "Working at Height", completedOn: "2026-01-21" } },
  }))
  const model = useStore(store)
  const dirty = useRef(false)
  const change = useCallback((fn: (draft: Model) => void) => {
    dirty.current = true
    store.edit(fn)
  }, [store])
  const [tab, setTab] = useState<Tab>("Layout")
  const [error, setError] = useState<unknown>(null)
  const [schemaJson, setSchemaJson] = useState(() => JSON.stringify(store.get().schema, null, 2))
  const [sampleJson, setSampleJson] = useState(() => JSON.stringify(store.get().settings.sampleData || {}, null, 2))

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [])

  // The preview shows the layout as it is when (re)loaded, not on every keystroke.
  const preview = useQuery({
    queryKey: ["template-preview", id ?? "new"],
    queryFn: () => {
      const m = store.get()
      return api<RenderResult>("POST", "/api/templates/preview", { html: m.html, schema: m.schema, data: m.settings.sampleData || {} })
    },
    staleTime: Infinity,
    gcTime: 0,
  })
  const refreshPreview = () => preview.refetch()

  const editSchema = (fn: (schema: Field[]) => void) => {
    change((d) => fn(d.schema))
    setSchemaJson(JSON.stringify(store.get().schema, null, 2))
  }

  const save = async () => {
    if (isNew) {
      const r = await api<SavedTemplate>("POST", "/api/templates", model)
      dirty.current = false
      toast("Template created")
      queries.invalidateQueries({ queryKey: ["templates"] })
      navigate(`/templates/${r.template.id}`)
      return
    }
    if (model.name !== template!.name || model.description !== template!.description) {
      await api("PATCH", `/api/templates/${id}`, { name: model.name, description: model.description })
    }
    const r = await api<SavedTemplate>("POST", `/api/templates/${id}/versions`, { html: model.html, schema: model.schema, settings: model.settings })
    dirty.current = false
    toast(r.unchanged ? "Saved (no layout changes)" : `Saved as version ${r.version.version}`)
    queries.invalidateQueries({ queryKey: ["templates"] })
    queries.invalidateQueries({ queryKey: ["template", id] })
  }

  const layoutPane = (
    <div>
      {!readOnly ? (
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="btn small">
            Upload .html / .hbs file
            <input type="file" accept=".html,.htm,.hbs,text/html" style={{ display: "none" }} onChange={async (e) => {
              const f = e.target.files?.[0]
              if (!f) return
              const html = await readText(f)
              change((d) => { d.html = html })
              toast(`Loaded ${f.name}`)
              refreshPreview()
            }} />
          </label>
        </div>
      ) : null}
      <textarea
        className="code"
        spellCheck={false}
        value={model.html}
        readOnly={readOnly}
        onChange={(e) => change((d) => { d.html = e.target.value })}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return
          e.preventDefault()
          const t = e.currentTarget
          t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end")
          change((d) => { d.html = t.value })
        }}
      />
      <details className="helper-ref card" style={{ marginTop: 10 }}>
        <summary>What can I use in the layout?</summary>
        <div style={{ marginTop: 8 }}>
          <p>
            Layouts are HTML with <a href="https://handlebarsjs.com/guide/" target="_blank" rel="noopener">Handlebars</a> placeholders. Each field's key becomes a placeholder, e.g. <code>{"{{recipientName}}"}</code>.
          </p>
          <ul>
            <li><code>{"{{document.no}}"}</code> number · <code>{"{{document.verificationCode}}"}</code> code under the QR</li>
            <li><code>{'<img src="{{qr}}">'}</code> QR code (empty in drafts) · <code>{"{{verifyUrl}}"}</code></li>
            <li><code>{"{{org.name}}"}</code>, <code>{"{{org.logo}}"}</code> your company</li>
            <li><code>{"{{preparedBy.name}}"}</code> / <code>.qualification</code> / <code>.signature</code> — the person who prepared it</li>
            <li><code>{"{{#if approvedBy}}…{{approvedBy.signature}}…{{/if}}"}</code> — the approver, only once issued</li>
            <li><code>{"{{#each (chunk items 10)}}…{{/each}}"}</code> split a table into pages of 10 rows</li>
            <li>Helpers: {HELPERS.map((x, i) => <span key={x}>{i ? ", " : ""}<code>{x}</code></span>)}</li>
          </ul>
          <p className="muted">Use inline CSS. External files can only load from a few public CDNs (Google Fonts, jsDelivr, cdnjs) — anything else is blocked when the PDF is made.</p>
        </div>
      </details>
    </div>
  )

  const fieldsPane = (
    <div>
      <FieldBuilder schema={model.schema} edit={editSchema} />
      <details style={{ marginTop: 12 }}>
        <summary>Edit as JSON</summary>
        <textarea className="code" spellCheck={false} style={{ minHeight: 360 }} value={schemaJson} onChange={(e) => setSchemaJson(e.target.value)} onBlur={() => {
          try {
            const schema = JSON.parse(schemaJson)
            change((d) => { d.schema = schema })
          } catch (err) {
            toast(`Fields JSON: ${errorMessage(err)}`, true)
          }
        }} />
      </details>
    </div>
  )

  const samplePane = (
    <div>
      <p className="muted">Example values used for the preview, and for “Fill with sample data” on new documents.</p>
      <textarea className="code" spellCheck={false} style={{ minHeight: 360 }} value={sampleJson} onChange={(e) => setSampleJson(e.target.value)} onBlur={() => {
        try {
          const sample = JSON.parse(sampleJson || "{}")
          change((d) => { d.settings.sampleData = sample })
        } catch (err) {
          toast(`Sample data: ${errorMessage(err)}`, true)
        }
      }} />
    </div>
  )

  const settingsPane = (
    <div className="stack">
      <label className="field">
        <span>Name</span>
        <input value={model.name} readOnly={readOnly} onChange={(e) => change((d) => { d.name = e.target.value })} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={2} value={model.description} readOnly={readOnly} onChange={(e) => change((d) => { d.description = e.target.value })} />
      </label>
      <div className="grid-2">
        <label className="field">
          <span>Number prefix</span>
          <input value={model.settings.numberPrefix || ""} onChange={(e) => change((d) => { d.settings.numberPrefix = e.target.value })} />
          <small>e.g. ELS/MTC-HB-</small>
        </label>
        <label className="field">
          <span>Digits</span>
          <input type="number" min={1} max={8} value={model.settings.numberPadding || 4} onChange={(e) => change((d) => { d.settings.numberPadding = Number(e.target.value) })} />
          <small>4 → 0001, 0002…</small>
        </label>
      </div>
      {!isNew && isAdmin ? (
        <div className="row">
          <AsyncButton onClick={async () => {
            await api("PATCH", `/api/templates/${id}`, { archived: !template!.archived })
            toast(template!.archived ? "Restored" : "Archived")
            queries.invalidateQueries({ queryKey: ["templates"] })
            queries.invalidateQueries({ queryKey: ["template", id] })
          }}>
            {template?.archived ? "Restore template" : "Archive template"}
          </AsyncButton>
          <span className="muted" style={{ fontSize: ".85rem" }}>Archived templates can't be used for new documents. Existing documents aren't affected.</span>
        </div>
      ) : null}
      {loaded?.history.length ? (
        <div>
          <h3>Versions</h3>
          <ul className="timeline">
            {loaded.history.map((v) => (
              <li key={v.id}>
                <time>{fmtDate(v.createdAt)}</time>
                Version {v.version}
                {v.id === template!.currentVersionId ? " (current)" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )

  const locked = (node: React.ReactNode) => (readOnly ? <fieldset disabled style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{node}</fieldset> : node)
  const panes: Record<Tab, React.ReactNode> = { Layout: layoutPane, Fields: locked(fieldsPane), "Sample data": locked(samplePane), Settings: locked(settingsPane) }

  return (
    <>
      <PageHead
        title={isNew ? "Add template" : model.name}
        sub={isNew ? "Start from the example, paste your own layout, or upload a file." : `Version ${version!.version}. Saving creates a new version — documents already made keep theirs.`}
        actions={
          <>
            {!isNew ? <Link className="btn" to={`/documents/new/${id}`}>New document</Link> : null}
            {!readOnly ? <AsyncButton className="btn primary" onError={setError} onClick={save}>{isNew ? "Create template" : "Save new version"}</AsyncButton> : null}
          </>
        }
      />
      <ErrorBox error={error} />
      <div className="editor-layout">
        <div>
          <div className="editor-tabs" role="tablist">
            {(Object.keys(panes) as Tab[]).map((name) => (
              <button key={name} type="button" role="tab" className={tab === name ? "active" : ""} onClick={() => setTab(name)}>
                {name}
              </button>
            ))}
          </div>
          <div>{panes[tab]}</div>
        </div>
        <div>
          <div className="row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Preview</h3>
            <span className="muted" style={{ fontSize: ".85rem" }}>with sample data</span>
            <div className="spacer" />
            <AsyncButton className="btn small" onClick={refreshPreview}>Refresh preview</AsyncButton>
          </div>
          <ErrorBox error={preview.error} />
          <PreviewFrame title="Template preview" result={preview.data ?? null} />
        </div>
      </div>
    </>
  )
}

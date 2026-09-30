// The PDF form template editor: upload a company's PDF and place boxes on it.
//
// The layout lives in a store (see shared/store.ts): every change goes through
// `change(draft => …)`. While a box is dragged it's moved in the DOM and in the
// model quietly, and everything redraws once on release, so dragging stays smooth.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react"
import { Link, useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { DocumentData, FormField, LayoutItem, RenderResult, SavedTemplate, SystemItem, TemplateDetail, UploadedSource } from "@doctrust/shared"
import { api } from "../api"
import { useMe } from "../session"
import { DocumentForm } from "../components/DocumentForm"
import { errorMessage, postPdf } from "../../shared/api"
import { drawPdfPage, fetchPreviewPdf, openPdf, renderPdfPages, type PdfDocument } from "../../shared/pdf"
import { createStore, useStore, type Store } from "../../shared/store"
import { AsyncButton } from "../../shared/ui/AsyncButton"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { Loading, PageHead } from "../../shared/ui/common"
import { Modal, useDialogs } from "../../shared/ui/Dialogs"
import { useToast } from "../../shared/ui/Toasts"
import {
  COL_TYPES, FAMILIES, TYPE_LABELS, applyChoice, applyEraseDefaults, clampItem, ensureTable, eraseAreas, eraseRect, exampleFor, fieldOf,
  isMultiline, isTextItem, itemLabel, keyFromLabel, placeholderData, sampleColors, syncTableRow, type EditorModel, type Placing,
} from "./model"
import { NewFieldDialog, type NewFieldChoice } from "./NewFieldDialog"
import { buildCleanSource } from "./cleanSource"

type Change = (fn: (draft: EditorModel) => void, options?: { quiet?: boolean }) => void

function initialModel(loaded?: TemplateDetail): EditorModel {
  const v = loaded?.version
  const settings = v ? { ...v.settings } : { numberPrefix: "", numberPadding: 4 }
  return {
    name: loaded?.template.name ?? "",
    description: loaded?.template.description ?? "",
    schema: JSON.parse(JSON.stringify(v?.schema ?? [])),
    items: JSON.parse(JSON.stringify(v?.layout?.items ?? [])),
    tables: JSON.parse(JSON.stringify(v?.layout?.tables ?? {})),
    pages: v?.layout?.pages ?? [],
    sourceHash: v?.sourceHash ?? null,
    originalHash: v?.layout?.originalSourceHash || v?.sourceHash || null,
    settings: { ...settings, sampleData: settings.sampleData && typeof settings.sampleData === "object" ? settings.sampleData : {} },
  }
}

export function PdfTemplateEditor({ id, loaded }: { id?: string; loaded?: TemplateDetail }) {
  const [store] = useState(() => createStore(initialModel(loaded)))
  const [uploaded, setUploaded] = useState<FormField[] | null>(null)
  const system = useQuery({
    queryKey: ["system-items"],
    queryFn: async () => (await api<{ items: SystemItem[] }>("GET", "/api/templates/system-items")).items,
    staleTime: Infinity,
  })
  if (!id && !uploaded) return <UploadStep store={store} onUploaded={setUploaded} />
  if (system.error) return <ErrorBox error={system.error} />
  if (!system.data) return <Loading />
  return <Editor id={id} loaded={loaded} store={store} system={Object.fromEntries(system.data.map((i) => [i.key, i]))} formFields={uploaded || []} />
}

// ---- Upload step (new template) --------------------------------------------------------

function UploadStep({ store, onUploaded }: { store: Store<EditorModel>; onUploaded: (formFields: FormField[]) => void }) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const handle = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (file.type && file.type !== "application/pdf") return setError(new Error("That's not a PDF file"))
    setBusy(`Uploading ${file.name}…`)
    try {
      const data = await postPdf<UploadedSource>("/api/templates/pdf-source", file)
      store.edit((m) => {
        m.sourceHash = data.sourceHash
        m.originalHash = data.sourceHash
        m.pages = data.pages
        if (!m.name) m.name = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim()
      })
      onUploaded(data.formFields || [])
    } catch (err) {
      setBusy(null)
      setError(err)
    }
  }
  return (
    <>
      <PageHead title="Upload your PDF form" sub="Use a blank copy of the form. You'll then mark where each piece of information goes." />
      <div className="stack" style={{ maxWidth: 720 }}>
        <label
          className={`upload-drop${busy ? " busy" : ""}${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files[0]) }}
        >
          <input type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={(e) => handle(e.target.files?.[0])} />
          <strong>{busy || "Choose your PDF form"}</strong>
          <span className="muted">or drag it here · up to 15 MB, 30 pages</span>
        </label>
        <ErrorBox error={error} />
        <div className="card">
          <h3>Tips</h3>
          <ul className="tips">
            <li>Use the original PDF from Word or your design software if you have it — it looks sharper than a scan.</li>
            <li>Scans work too. Scan straight, at 300 dpi, on a clean blank form.</li>
            <li>Leave a space for the QR code, e.g. in a corner of the header. You can place it anywhere.</li>
            <li>If the PDF has fillable fields, we'll find them for you.</li>
            <li>Only have a filled-in copy? Upload it anyway — tick “Erase what's printed under this box” on each box to remove the old information.</li>
          </ul>
        </div>
      </div>
    </>
  )
}

// ---- The editor ------------------------------------------------------------------------

const findItem = (m: EditorModel, id: string) => m.items.find((i) => i.id === id)!

function Editor({ id, loaded, store, system, formFields }: {
  id?: string
  loaded?: TemplateDetail
  store: Store<EditorModel>
  system: Record<string, SystemItem>
  formFields: FormField[]
}) {
  const m = useStore(store)
  const { me, org, isAdmin } = useMe()
  const readOnly = !isAdmin
  const navigate = useNavigate()
  const queries = useQueryClient()
  const dialogs = useDialogs()
  const toast = useToast()
  const dirty = useRef(false)
  const change = useCallback<Change>((fn, options) => {
    dirty.current = true
    store.edit(fn, options)
  }, [store])

  const [selected, setSelected] = useState<string | null>(null)
  const [placing, setPlacing] = useState<Placing | null>(null)
  const [zoom, setZoom] = useState(1)
  // New boxes replace what's printed under them unless the admin turns this off.
  const [eraseByDefault, setEraseByDefault] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [showDetected, setShowDetected] = useState(formFields.length > 0 && !readOnly)
  const [hostWidth, setHostWidth] = useState(0)
  const pagesHost = useRef<HTMLDivElement>(null)
  const canvases = useRef<Array<HTMLCanvasElement | null>>([])
  // The erase areas the current cleaned copy of the form was made for.
  const erasedSig = useRef(loaded?.version.layout?.originalSourceHash ? JSON.stringify(eraseAreas(store.get())) : "")
  const nextId = useRef(Math.max(0, ...store.get().items.map((it) => Number(String(it.id).replace(/\D/g, "")) || 0)) + 1)
  const newId = () => `b${nextId.current++}`
  const who = { name: me.name, qualification: me.qualification || "", org: org.name }
  const canvasFor = (page: number) => canvases.current[page] ?? undefined

  // The uploaded form, loaded once.
  const pdf = useQuery({
    queryKey: ["pdf-source", m.originalHash],
    queryFn: (): Promise<PdfDocument> => openPdf(`/api/templates/pdf-source/${m.originalHash}`),
    staleTime: Infinity,
    gcTime: 0,
  })

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [])

  // Page width follows the available space (redrawn when it changes noticeably).
  useEffect(() => {
    const host = pagesHost.current
    if (!host) return
    const ro = new ResizeObserver(() => setHostWidth((w) => (Math.abs(host.clientWidth - w) > 40 ? host.clientWidth : w)))
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  const scale = useMemo(() => {
    const avail = Math.max(320, hostWidth - 8)
    const maxW = Math.max(...m.pages.map((p) => p.width), 1)
    return (avail / maxW) * zoom
  }, [hostWidth, zoom, m.pages])

  // Draw the pages whenever the form or the scale changes.
  useEffect(() => {
    const doc = pdf.data
    if (!doc || !hostWidth) return
    m.pages.forEach((_, i) => {
      const canvas = canvases.current[i]
      if (canvas) drawPdfPage(doc, i, scale, canvas).catch((e) => toast(`Couldn't draw page ${i + 1}: ${errorMessage(e)}`, true))
    })
  }, [pdf.data, scale, hostWidth, m.pages, toast])

  // ---- Drawing a new box --------------------------------------------------------------

  const toPt = (overlay: HTMLElement, e: { clientX: number; clientY: number }) => {
    const r = overlay.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }

  const addBox = (item: LayoutItem, choice: NewFieldChoice | null) => {
    change((d) => {
      if (choice) applyChoice(d, item, choice)
      clampItem(d, item)
      if (item.kind === "column") ensureTable(d, item)
      if (eraseByDefault) applyEraseDefaults(d, item, canvasFor(item.page))
      d.items.push(item)
    })
    setSelected(item.id)
  }

  const onOverlayPointerDown = (e: ReactPointerEvent<HTMLDivElement>, pageIndex: number) => {
    if (readOnly || e.target !== e.currentTarget || e.button !== 0) return
    e.preventDefault()
    const overlay = e.currentTarget
    overlay.setPointerCapture(e.pointerId)
    const start = toPt(overlay, e)
    const ghost = document.createElement("div")
    ghost.className = "pdraw"
    overlay.append(ghost)
    let rect = { x: start.x, y: start.y, w: 0, h: 0 }
    const move = (ev: PointerEvent) => {
      const p = toPt(overlay, ev)
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }
      ghost.style.cssText = `left:${rect.x * scale}px;top:${rect.y * scale}px;width:${rect.w * scale}px;height:${rect.h * scale}px`
    }
    const up = async () => {
      overlay.removeEventListener("pointermove", move)
      overlay.removeEventListener("pointerup", up)
      ghost.remove()
      if (rect.w < 4 || rect.h < 4) {
        // A click: with something to place, drop a default-sized box here.
        if (!placing) {
          setSelected(null)
          return
        }
        const qr = placing.kind === "system" && placing.key === "qr"
        rect = { x: start.x, y: start.y - 7, w: qr ? 60 : placing.w || 140, h: qr ? 60 : placing.h || 14 }
      }
      const item: LayoutItem = { id: newId(), page: pageIndex, kind: "field", ...rect }
      if (placing) {
        Object.assign(item, { kind: placing.kind }, placing.kind === "column" ? { table: placing.table, column: placing.column } : { key: placing.key })
        setPlacing(null)
        return addBox(item, null)
      }
      const model = store.get()
      const choice = await dialogs.open<NewFieldChoice>((close) => (
        <NewFieldDialog
          unplacedFields={model.schema.filter((f) => f.type !== "table" && !model.items.some((i) => i.kind === "field" && i.key === f.key))}
          unplacedSystem={Object.values(system).filter((si) => !model.items.some((i) => i.kind === "system" && i.key === si.key))}
          tables={model.schema.filter((f) => f.type === "table")}
          onClose={close}
        />
      ))
      if (!choice) return
      if (choice.what === "new" && !choice.label.trim()) return toast("Give the field a name", true)
      addBox(item, choice)
    }
    overlay.addEventListener("pointermove", move)
    overlay.addEventListener("pointerup", up)
  }

  // ---- Moving and resizing a box --------------------------------------------------------

  const onBoxPointerDown = (e: ReactPointerEvent<HTMLDivElement>, it: LayoutItem) => {
    if (readOnly || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const overlay = el.parentElement!
    const resizing = (e.target as HTMLElement).classList.contains("pbox-handle")
    const start = toPt(overlay, e)
    const orig = { ...it }
    let moved = false
    if (selected !== it.id) setSelected(it.id)
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const p = toPt(overlay, ev)
      const dx = p.x - start.x
      const dy = p.y - start.y
      if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true
      change((d) => {
        const cur = findItem(d, it.id)
        if (resizing) {
          cur.w = orig.w + dx
          cur.h = orig.h + dy
        } else {
          cur.x = orig.x + dx
          cur.y = orig.y + dy
        }
        clampItem(d, cur)
        Object.assign(el.style, { left: `${cur.x * scale}px`, top: `${cur.y * scale}px`, width: `${cur.w * scale}px`, height: `${cur.h * scale}px` })
      }, { quiet: true })
    }
    const up = () => {
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      if (moved) change((d) => {
        const cur = findItem(d, it.id)
        if (cur.kind === "column") syncTableRow(d, cur, orig)
      })
    }
    el.addEventListener("pointermove", move)
    el.addEventListener("pointerup", up)
  }

  // Keyboard: nudge / delete the selected box.
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName
      if (!selected || (tag && ["INPUT", "TEXTAREA", "SELECT"].includes(tag))) return
      if (!store.get().items.some((i) => i.id === selected)) return
      const step = e.shiftKey ? 5 : 0.5
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (moves[e.key]) {
        e.preventDefault()
        change((d) => {
          const it = findItem(d, selected)
          const orig = { ...it }
          it.x += moves[e.key][0]
          it.y += moves[e.key][1]
          clampItem(d, it)
          if (it.kind === "column") syncTableRow(d, it, orig)
        })
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        change((d) => { d.items = d.items.filter((i) => i.id !== selected) })
        setSelected(null)
      } else if (e.key === "Escape") {
        setSelected(null)
        setPlacing(null)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [selected, readOnly, store, change])

  const select = (itemId: string) => {
    setSelected(itemId)
    setTimeout(() => pagesHost.current?.querySelector(`.pbox[data-id="${itemId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }))
  }
  const startPlacing = (p: Placing) => {
    setPlacing(p)
    setSelected(null)
    toast("Now click on the page where it goes")
  }

  // ---- Preview & save -------------------------------------------------------------------

  // Erase areas need a cleaned copy of the form (made in the browser, then uploaded).
  const ensureCleanSource = async () => {
    const model = store.get()
    const areas = eraseAreas(model)
    const sig = JSON.stringify(areas)
    if (!areas.length) {
      store.edit((d) => { d.sourceHash = d.originalHash }, { quiet: true })
      erasedSig.current = ""
      return
    }
    if (sig === erasedSig.current && model.sourceHash && model.sourceHash !== model.originalHash) return
    if (!pdf.data) throw new Error("The form is still loading")
    const hash = await buildCleanSource(model, areas, pdf.data)
    store.edit((d) => { d.sourceHash = hash }, { quiet: true })
    erasedSig.current = sig
  }
  const layoutBody = () => {
    const model = store.get()
    return { items: model.items, tables: model.tables, originalSourceHash: model.sourceHash !== model.originalHash ? model.originalHash : undefined }
  }

  const preview = async () => {
    await ensureCleanSource()
    const model = store.get()
    const r = await api<RenderResult>("POST", "/api/templates/preview", {
      kind: "pdf", sourceHash: model.sourceHash, schema: model.schema, layout: layoutBody(), data: placeholderData(model.schema, model.settings.sampleData),
    })
    dialogs.open<boolean>((close) => <PreviewDialog previewUrl={r.previewUrl} onClose={() => close(true)} />)
  }

  const save = async () => {
    const model = store.get()
    if (!model.name.trim()) throw new Error("Give the template a name (in the panel on the right)")
    if (!model.items.some((i) => i.kind === "system" && i.key === "qr")) {
      if (!(await dialogs.confirm("No QR code on the page", <p>Partners scan the QR code to verify a document. Save without it?</p>, { submitLabel: "Save anyway" }))) return
    }
    await ensureCleanSource()
    const body = { kind: "pdf", sourceHash: store.get().sourceHash, schema: model.schema, layout: layoutBody(), settings: model.settings }
    let r: SavedTemplate
    if (!id) {
      r = await api<SavedTemplate>("POST", "/api/templates", { name: model.name, description: model.description, ...body })
    } else {
      if (model.name !== loaded!.template.name || model.description !== loaded!.template.description) {
        await api("PATCH", `/api/templates/${id}`, { name: model.name, description: model.description })
      }
      r = await api<SavedTemplate>("POST", `/api/templates/${id}/versions`, body)
    }
    dirty.current = false
    const note = r.unplaced?.length ? ` Not on the page yet: ${r.unplaced.join(", ")}.` : ""
    toast(`${!id ? "Template created." : r.unchanged ? "No changes." : `Saved as version ${r.version.version}.`}${note}`)
    queries.invalidateQueries({ queryKey: ["templates"] })
    if (id) queries.invalidateQueries({ queryKey: ["template", id] })
    else navigate(`/templates/${r.template.id}`, { replace: true })
  }

  const editExamples = async () => {
    const values = await dialogs.open<DocumentData>((close) => <ExamplesDialog model={store.get()} onClose={close} />)
    if (values) change((d) => { d.settings.sampleData = values })
  }

  const addDetected = () => {
    change((d) => {
      const taken = new Set(d.schema.map((f) => f.key))
      for (const ff of formFields) {
        const key = keyFromLabel(ff.label, taken)
        taken.add(key)
        d.schema.push({ key, label: ff.label, type: ff.type, ...(ff.options ? { options: ff.options } : {}) })
        d.items.push({ id: newId(), kind: "field", key, page: ff.page, x: ff.x, y: ff.y, w: Math.max(4, ff.w), h: Math.max(4, ff.h) })
      }
    })
    setShowDetected(false)
    toast(`${formFields.length} fields added — check their names and types`)
  }

  // ---- Page ------------------------------------------------------------------------------

  const valueEl = (it: LayoutItem, text: string) => {
    if (!text) return null
    const auto = isMultiline(m, it) ? Math.min(12, it.h * 0.72) : it.h * 0.72
    const size = Math.max(5, Math.min(it.fontSize || auto, it.h * 0.9)) * scale
    const color = it.kind === "system" && it.key === "approvedBy.name" ? "#777" : it.color || "#0d0d1f"
    return (
      <span
        className={`pbox-value${isMultiline(m, it) ? " multi" : ""}`}
        style={{
          fontSize: size,
          fontFamily: FAMILIES[it.font || "sans"],
          fontWeight: it.bold ? 700 : 400,
          color,
          justifyContent: text === "✓" || it.align === "center" ? "center" : it.align === "right" ? "flex-end" : "flex-start",
        }}
      >
        {text}
      </span>
    )
  }

  const boxesOn = (page: number) => {
    const out: ReactNode[] = []
    for (const it of m.items) {
      if (it.page !== page) continue
      const s = scale
      const value = exampleFor(m, it, who)
      const cover = it.erase && it.kind === "column" ? { background: it.eraseColor || "#ffffff" } : {}
      if (it.erase && it.kind !== "column") {
        const r = eraseRect(m, it)
        out.push(<div key={`cover-${it.id}`} className="pcover" style={{ left: r.x * s, top: r.y * s, width: r.w * s, height: r.h * s, background: it.eraseColor || "#ffffff" }} />)
      }
      out.push(
        <div
          key={it.id}
          className={`pbox k-${it.kind}${selected === it.id ? " sel" : ""}${value ? " has-value" : ""}${it.erase ? " erasing" : ""}`}
          style={{ left: it.x * s, top: it.y * s, width: it.w * s, height: it.h * s, ...cover }}
          title={itemLabel(m, system, it)}
          data-id={it.id}
          onPointerDown={(e) => onBoxPointerDown(e, it)}
        >
          {valueEl(it, value)}
          <span className="pbox-label">{itemLabel(m, system, it)}</span>
          {readOnly ? null : <span className="pbox-handle" aria-hidden="true" />}
        </div>,
      )
      // Where the following table rows will go, with example rows filled in.
      if (it.kind === "column") {
        const t = m.tables[it.table!] || {}
        const rh = t.rowHeight || it.h
        const rows = Math.min(t.rowsPerPage || 1, 60)
        for (let r = 1; r < rows; r++) {
          if (it.y + r * rh + it.h > m.pages[it.page].height) break
          out.push(
            <div key={`${it.id}-row${r}`} className="pghost" style={{ left: it.x * s, top: (it.y + r * rh) * s, width: it.w * s, height: it.h * s, ...cover }}>
              {valueEl(it, exampleFor(m, it, who, r))}
            </div>,
          )
        }
      }
    }
    return out
  }

  const sel = selected ? m.items.find((i) => i.id === selected) : undefined
  const v = loaded?.version

  return (
    <>
      <PageHead
        title={id ? m.name : "Mark the fields on your form"}
        sub={id ? `PDF form · version ${v!.version}. Saving creates a new version — documents already issued keep theirs.` : "Drag a box wherever information should be printed. Place the QR code too."}
        actions={
          <>
            {id ? <Link className="btn" to={`/documents/new/${id}`}>New document</Link> : null}
            <AsyncButton onClick={preview} onError={setError}>Preview</AsyncButton>
            {readOnly ? null : <AsyncButton className="btn primary" onClick={save} onError={setError}>{id ? "Save new version" : "Create template"}</AsyncButton>}
          </>
        }
      />
      <ErrorBox error={error || pdf.error} />
      {showDetected ? (
        <div className="notice info row">
          <span>This PDF has {formFields.length} fillable field{formFields.length === 1 ? "" : "s"}. Add them automatically?</span>
          <div className="spacer" />
          <button className="btn small primary" onClick={addDetected}>Add them</button>
        </div>
      ) : null}
      <div className="pdf-editor">
        <div className="pdf-main">
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="pdf-status">{m.pages.length} page{m.pages.length === 1 ? "" : "s"}</div>
            <div className="spacer" />
            <div className="row zoom">
              <button className="btn small" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}>−</button>
              <button className="btn small" onClick={() => setZoom(1)}>Fit</button>
              <button className="btn small" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>+</button>
            </div>
          </div>
          <div className="pdf-pages" ref={pagesHost}>
            {hostWidth
              ? m.pages.map((pg, i) => (
                  <div key={i} className="pdf-page" style={{ width: pg.width * scale, height: pg.height * scale }}>
                    <canvas className="pdf-canvas" ref={(el) => { canvases.current[i] = el }} />
                    <div className="pdf-overlay" data-page={i} onPointerDown={(e) => onOverlayPointerDown(e, i)}>
                      {boxesOn(i)}
                    </div>
                    <div className="pdf-page-no">Page {i + 1} of {m.pages.length}</div>
                  </div>
                ))
              : null}
          </div>
        </div>
        <aside className="pdf-side">
          {!readOnly ? (
            <div className="card pdf-hint">
              {placing ? (
                <>
                  <strong>Placing: {placing.label}</strong>
                  <p className="muted" style={{ margin: "4px 0 8px" }}>Click on the page, or drag to draw the box.</p>
                  <button className="btn small" onClick={() => setPlacing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <strong>Drag on the page to add a box</strong>
                  <p className="muted" style={{ margin: "4px 0 0" }}>Draw where the information should be printed, then say what goes there. Drag boxes to move them; drag the corner to resize.</p>
                  <label className="check" style={{ marginTop: 10, fontSize: ".9rem" }}>
                    <input type="checkbox" checked={eraseByDefault} onChange={(e) => setEraseByDefault(e.target.checked)} />
                    New boxes replace what's printed under them
                  </label>
                  <p className="muted" style={{ margin: "8px 0 0", fontSize: ".85rem" }}>
                    Values you type here are only examples to check the layout. Your team enters the real values on each document (Documents → New document), then sends it for approval.
                  </p>
                </>
              )}
            </div>
          ) : null}

          {sel && !readOnly ? (
            <PropsPanel
              key={sel.id}
              model={m}
              item={sel}
              label={itemLabel(m, system, sel)}
              canvasFor={canvasFor}
              edit={(fn) => change((d) => fn(findItem(d, sel.id), d))}
              onClose={() => setSelected(null)}
              onRemove={() => { change((d) => { d.items = d.items.filter((i) => i.id !== sel.id) }); setSelected(null) }}
              onDeleteField={() => {
                change((d) => {
                  d.schema = d.schema.filter((f) => f.key !== sel.key)
                  d.items = d.items.filter((i) => !(i.kind === "field" && i.key === sel.key))
                })
                setSelected(null)
              }}
            />
          ) : null}

          <div className="card">
            <h3>Fields ({m.schema.length})</h3>
            {m.schema.length ? (
              <div className="fl-list">
                {m.schema.map((f) => {
                  if (f.type === "table") {
                    const cols = [{ key: "#", label: "S/N (row number)" }, ...(f.columns || [])]
                    return (
                      <div key={f.key} className="fl-item">
                        <div className="fl-head"><strong>{f.label}</strong><span className="muted"> · table</span></div>
                        {cols.map((c) => {
                          const placed = m.items.find((i) => i.kind === "column" && i.table === f.key && i.column === c.key)
                          if (c.key === "#" && !placed && readOnly) return null
                          return (
                            <div key={c.key} className="fl-sub">
                              <span>{c.label}</span>
                              {placed ? <button className="chip ok" onClick={() => select(placed.id)}>placed</button>
                                : readOnly ? <span className="chip">not placed</span>
                                  : <button className="chip" onClick={() => startPlacing({ kind: "column", table: f.key, column: c.key, label: `${f.label} › ${c.label}`, w: 80, h: m.tables[f.key]?.rowHeight || 16 })}>place</button>}
                            </div>
                          )
                        })}
                      </div>
                    )
                  }
                  const placed = m.items.filter((i) => i.kind === "field" && i.key === f.key)
                  return (
                    <div key={f.key} className="fl-item">
                      <div className="fl-head">
                        <strong>{f.label}</strong>
                        <span className="muted">{` · ${TYPE_LABELS[f.type] || f.type}${f.required ? " · required" : ""}`}</span>
                      </div>
                      <div className="fl-sub">
                        {placed.length ? <button className="chip ok" onClick={() => select(placed[0].id)}>on page {placed[0].page + 1}</button> : <span className="chip warn">not on the page</span>}
                        {!readOnly ? (
                          <button className="chip" onClick={() => startPlacing({ kind: "field", key: f.key, label: f.label, w: f.type === "checkbox" ? 12 : 140, h: f.type === "checkbox" ? 12 : f.type === "textarea" ? 36 : 14 })}>
                            {placed.length ? "place again" : "place"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="muted">None yet. Draw a box on the page to add one.</p>
            )}
          </div>

          {!readOnly && m.schema.length ? (
            <div className="card">
              <h3>Example values</h3>
              <p className="muted" style={{ fontSize: ".85rem" }}>Shown in the boxes and in Preview, and offered as “Fill with sample data” on new documents.</p>
              <button className="btn small" onClick={editExamples}>Edit example values</button>
            </div>
          ) : null}

          <div className="card">
            <h3>Filled in automatically</h3>
            <p className="muted" style={{ fontSize: ".85rem" }}>Place the QR code and signatures where they belong. They're filled in when a document is issued.</p>
            <div className="fl-list">
              {Object.values(system).map((si) => {
                const placed = m.items.find((i) => i.kind === "system" && i.key === si.key)
                if (readOnly && !placed) return null
                return (
                  <div key={si.key} className="fl-sub">
                    <span>{si.label}{si.key === "qr" ? <span className="req"> *</span> : null}</span>
                    {placed ? <button className="chip ok" onClick={() => select(placed.id)}>placed</button>
                      : <button className="chip" onClick={() => startPlacing({ kind: "system", key: si.key, label: si.label, w: si.type === "image" ? 110 : si.key === "qr" ? 60 : 140, h: si.type === "image" ? 30 : si.key === "qr" ? 60 : 14 })}>place</button>}
                  </div>
                )
              })}
            </div>
          </div>

          {!readOnly ? (
            <div className="card stack">
              <h3>Template</h3>
              <label className="field">
                <span>Name</span>
                <input value={m.name} onChange={(e) => change((d) => { d.name = e.target.value })} />
              </label>
              <label className="field">
                <span>Description</span>
                <textarea rows={2} value={m.description} onChange={(e) => change((d) => { d.description = e.target.value })} />
              </label>
              <div className="grid-2">
                <label className="field">
                  <span>Number prefix</span>
                  <input value={m.settings.numberPrefix || ""} placeholder="e.g. PT/" onChange={(e) => change((d) => { d.settings.numberPrefix = e.target.value })} />
                </label>
                <label className="field">
                  <span>Digits</span>
                  <input type="number" min={1} max={8} value={m.settings.numberPadding || 4} onChange={(e) => change((d) => { d.settings.numberPadding = Number(e.target.value) })} />
                </label>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </>
  )
}

// ---- The selected box's settings ------------------------------------------------------

function PropsPanel({ model: m, item: it, label, canvasFor, edit, onClose, onRemove, onDeleteField }: {
  model: EditorModel
  item: LayoutItem
  label: string
  canvasFor: (page: number) => HTMLCanvasElement | undefined
  // Changes this box (and anything else in the model).
  edit: (fn: (item: LayoutItem, model: EditorModel) => void) => void
  onClose: () => void
  onRemove: () => void
  onDeleteField: () => void
}) {
  const toast = useToast()
  const f = it.kind === "field" ? fieldOf(m, it.key) : undefined
  const table = it.kind === "column" ? fieldOf(m, it.table) : undefined
  const col = it.kind === "column" && it.column !== "#" ? table?.columns?.find((x) => x.key === it.column) : undefined
  const tableLayout = it.kind === "column" ? m.tables[it.table!] || { rowHeight: it.h, rowsPerPage: 10 } : undefined
  const sd = m.settings.sampleData
  const splitOptions = (s: string) => s.split(",").map((o) => o.trim()).filter(Boolean)
  // Edits this box's field / column / table layout in the model.
  const editField = (fn: (field: NonNullable<typeof f>) => void) => edit((x, d) => fn(fieldOf(d, x.key)!))
  const editColumn = (fn: (column: NonNullable<typeof col>) => void) => edit((x, d) => fn(fieldOf(d, x.table)!.columns!.find((c) => c.key === x.column)!))
  const editTable = (fn: (t: { rowHeight?: number; rowsPerPage?: number }) => void) =>
    edit((x, d) => fn(d.tables[x.table!] || (d.tables[x.table!] = { rowHeight: x.h, rowsPerPage: 10 })))

  const exampleInput = (type: string, options: string[] | undefined, value: unknown, set: (v: unknown, d: EditorModel) => void) => {
    const onValue = (v: unknown) => edit((_, d) => set(v, d))
    if (type === "checkbox") {
      return (
        <label className="check">
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => onValue(e.target.checked)} />
          Example: ticked
        </label>
      )
    }
    let input: ReactNode
    if (type === "select") {
      input = (
        <select value={String(value ?? "")} onChange={(e) => onValue(e.target.value)}>
          <option value="">—</option>
          {(options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    } else if (type === "textarea") {
      input = <textarea rows={2} value={String(value ?? "")} onChange={(e) => onValue(e.target.value)} />
    } else {
      input = <input type={type === "number" ? "number" : type === "date" ? "date" : "text"} value={String(value ?? "")} onChange={(e) => onValue(e.target.value)} />
    }
    return <label className="field"><span>Example value</span>{input}</label>
  }

  return (
    <div className="card stack props">
      <div className="row">
        <h3 style={{ margin: 0 }}>{label}</h3>
        <div className="spacer" />
        <button className="btn small ghost" aria-label="Close" onClick={onClose}>✕</button>
      </div>

      {f ? (
        <>
          <label className="field">
            <span>Field name</span>
            <input value={f.label} onChange={(e) => editField((x) => { x.label = e.target.value })} />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={f.type} onChange={(e) => editField((x) => {
              x.type = e.target.value as typeof x.type
              if (x.type === "select" && !x.options) x.options = ["Option 1", "Option 2"]
              if (x.type === "checkbox") x.required = false
            })}>
              {Object.entries(TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {f.type === "select" ? (
            <label className="field">
              <span>Choices (comma separated)</span>
              <input defaultValue={(f.options || []).join(", ")} onBlur={(e) => editField((x) => { x.options = splitOptions(e.target.value) })} />
            </label>
          ) : null}
          <div className="row">
            {f.type !== "checkbox" ? (
              <label className="check">
                <input type="checkbox" checked={Boolean(f.required)} onChange={(e) => editField((x) => { x.required = e.target.checked })} />
                Required
              </label>
            ) : null}
            {!["image", "checkbox"].includes(f.type) ? (
              <label className="check">
                <input type="checkbox" checked={Boolean(f.showOnVerify)} onChange={(e) => editField((x) => { x.showOnVerify = e.target.checked })} />
                Show on verify page
              </label>
            ) : null}
          </div>
        </>
      ) : null}

      {col ? (
        <>
          <label className="field">
            <span>Column name</span>
            <input value={col.label} onChange={(e) => editColumn((x) => { x.label = e.target.value })} />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={col.type} onChange={(e) => editColumn((x) => {
              x.type = e.target.value as typeof x.type
              if (x.type === "select" && !x.options) x.options = ["Option 1", "Option 2"]
            })}>
              {COL_TYPES.map((k) => <option key={k} value={k}>{TYPE_LABELS[k]}</option>)}
            </select>
          </label>
          {col.type === "select" ? (
            <label className="field">
              <span>Choices (comma separated)</span>
              <input defaultValue={(col.options || []).join(", ")} onBlur={(e) => editColumn((x) => { x.options = splitOptions(e.target.value) })} />
            </label>
          ) : null}
          <label className="check">
            <input type="checkbox" checked={Boolean(col.required)} onChange={(e) => editColumn((x) => { x.required = e.target.checked })} />
            Required
          </label>
        </>
      ) : null}

      {tableLayout ? (
        <>
          <div className="grid-2">
            <label className="field">
              <span>Row spacing (pt)</span>
              <input type="number" step="0.5" min={4} defaultValue={tableLayout.rowHeight} onChange={(e) => {
                const n = Number(e.target.value)
                editTable((t) => { t.rowHeight = n || it.h })
              }} />
            </label>
            <label className="field">
              <span>Rows per page</span>
              <input type="number" min={1} max={200} defaultValue={tableLayout.rowsPerPage} onChange={(e) => {
                const n = Math.max(1, Number(e.target.value) || 1)
                editTable((t) => { t.rowsPerPage = n })
              }} />
            </label>
          </div>
          <p className="muted" style={{ fontSize: ".82rem", margin: 0 }}>Set these so the dashed boxes line up with the rows printed on your form. Rows beyond this continue on a copy of the page.</p>
        </>
      ) : null}

      {isTextItem(m, it) ? (
        <div className="grid-2">
          <label className="field">
            <span>Text size</span>
            <select value={it.fontSize ?? ""} onChange={(e) => edit((x) => { x.fontSize = e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Auto (fill the box)</option>
              {[6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36].map((n) => <option key={n} value={n}>{n} pt</option>)}
            </select>
          </label>
          <label className="field">
            <span>Align</span>
            <select value={it.align || "left"} onChange={(e) => edit((x) => { x.align = e.target.value as LayoutItem["align"] })}>
              {["left", "center", "right"].map((a) => <option key={a} value={a}>{a[0].toUpperCase() + a.slice(1)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Font</span>
            <select value={it.font || "sans"} onChange={(e) => edit((x) => { x.font = e.target.value === "sans" ? undefined : (e.target.value as LayoutItem["font"]) })}>
              <option value="sans">Sans (Helvetica)</option>
              <option value="serif">Serif (Times)</option>
              <option value="mono">Mono (Courier)</option>
            </select>
          </label>
          <div className="field">
            <span className="flabel">Text colour</span>
            <div className="row" style={{ gap: 6 }}>
              <input type="color" className="color-in" value={it.color || "#0d0d1f"} aria-label="Text colour" onChange={(e) => edit((x) => { x.color = e.target.value })} />
              <button className="btn small" title="Use the colour of the text printed here on the form" onClick={() => {
                const { ink } = sampleColors(m, it, canvasFor(it.page))
                if (ink) edit((x) => { x.color = ink })
                else toast("No text found under this box to match")
              }}>Match</button>
            </div>
          </div>
          <label className="check full">
            <input type="checkbox" checked={Boolean(it.bold)} onChange={(e) => edit((x) => { x.bold = e.target.checked || undefined })} />
            Bold
          </label>
        </div>
      ) : null}

      {f && f.type !== "image" ? exampleInput(f.type, f.options, sd[f.key], (val, d) => { d.settings.sampleData[f.key] = val }) : null}
      {col && table ? exampleInput(col.type, col.options, ((sd[table.key] as Array<Record<string, unknown>> | undefined)?.[0] || {})[col.key], (val, d) => {
        const data = d.settings.sampleData
        if (!Array.isArray(data[table.key]) || !(data[table.key] as unknown[]).length) data[table.key] = [{}]
        ;(data[table.key] as Array<Record<string, unknown>>)[0][col.key] = val
      }) : null}
      {it.kind === "system" && it.key?.startsWith("approvedBy.") ? (
        <p className="muted" style={{ fontSize: ".82rem", margin: 0 }}>Filled in when an approver approves the document. Until then drafts show “Awaiting approval” here.</p>
      ) : it.kind === "system" && it.key?.startsWith("preparedBy.") ? (
        <p className="muted" style={{ fontSize: ".82rem", margin: 0 }}>Filled in from the profile of the person who prepares the document (Settings → Your profile).</p>
      ) : null}

      <div className="erase-box">
        <label className="check">
          <input type="checkbox" checked={Boolean(it.erase)} onChange={(e) => {
            const on = e.target.checked
            const bg = on && !it.eraseColor ? sampleColors(m, it, canvasFor(it.page)).bg : undefined
            edit((x) => {
              x.erase = on
              if (bg) x.eraseColor = bg
            })
          }} />
          Erase what's printed under this box
        </label>
        {it.erase ? (
          <div className="row" style={{ marginTop: 6 }}>
            <input type="color" className="color-in" value={it.eraseColor || "#ffffff"} aria-label="Cover colour" onChange={(e) => edit((x) => { x.eraseColor = e.target.value })} />
            <button className="btn small" onClick={() => {
              const bg = sampleColors(m, it, canvasFor(it.page)).bg
              edit((x) => { x.eraseColor = bg })
            }}>Match the page colour</button>
          </div>
        ) : null}
        <p className="muted" style={{ fontSize: ".8rem", margin: "6px 0 0" }}>
          {it.kind === "column"
            ? "Clears this column in every row. Use it when your PDF already has old information here — it's removed from the form, not just hidden."
            : "Use it when your PDF already has old information here — it's removed from the form, not just hidden."}
        </p>
      </div>

      <div className="row">
        <button className="btn small danger" onClick={onRemove}>Remove box</button>
        {it.kind === "field" ? <button className="btn small ghost" onClick={onDeleteField}>Delete field</button> : null}
      </div>
      <p className="muted" style={{ fontSize: ".78rem", margin: 0 }}>
        Page {it.page + 1} · x {it.x} · y {it.y} · {it.w} × {it.h} pt. Arrow keys nudge; Delete removes.
      </p>
    </div>
  )
}

// ---- Dialogs ------------------------------------------------------------------------------

function ExamplesDialog({ model, onClose }: { model: EditorModel; onClose: (values: DocumentData | null) => void }) {
  const [values, setValues] = useState<DocumentData>(() => JSON.parse(JSON.stringify(model.settings.sampleData || {})))
  return (
    <Modal onCancel={() => onClose(null)} wide>
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); onClose(values) }}>
        <h2>Example values</h2>
        <p className="muted">Used to check the layout, in Preview, and for “Fill with sample data” on new documents. Real values are entered on each document.</p>
        <DocumentForm schema={model.schema} value={values} onChange={setValues} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" type="button" onClick={() => onClose(null)}>Cancel</button>
          <button className="btn primary" type="submit">Use these values</button>
        </div>
      </form>
    </Modal>
  )
}

function PreviewDialog({ previewUrl, onClose }: { previewUrl: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const pages = useQuery({
    queryKey: ["preview-pdf", previewUrl],
    queryFn: () => fetchPreviewPdf(previewUrl),
    staleTime: Infinity,
    gcTime: 0,
  })
  useEffect(() => {
    if (pages.data && host.current) renderPdfPages(host.current, pages.data)
  }, [pages.data])
  return (
    <Modal onCancel={onClose} wide>
      <div style={{ padding: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Preview</h2>
          <span className="muted">with example values</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <ErrorBox error={pages.error} />
        <div className="pdf-scroll" style={{ height: "70vh" }} ref={host} />
      </div>
    </Modal>
  )
}

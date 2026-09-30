// The PDF form template editor: upload a company's PDF and place boxes on it.
import { ApiError } from "../lib/api.js"
import { busy, errorBox, h, modal, toast } from "../lib/dom.js"
import { api } from "./api.js"
import { buildForm } from "./form.js"
import { drawPdfPage, openPdf, renderPdfPages } from "./pdf-view.js"
import { go } from "../lib/router.js"
import { pageHead, shell } from "./shell.js"
import { isAdmin, state } from "./state.js"

export const TYPE_LABELS = { text: "Text", textarea: "Long text", number: "Number", date: "Date", select: "Dropdown", checkbox: "Tick box", image: "Image" }
export const COL_TYPES = ["text", "number", "date", "select", "checkbox"]

export function keyFromLabel(label, taken) {
  const words = String(label).normalize("NFKD").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean)
  let key = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("").slice(0, 40)
  if (!/^[a-zA-Z]/.test(key)) key = `field${key}`
  const reserved = ["document", "org", "qr", "verifyUrl", "preparedBy", "approvedBy", "isDraft", "data", "pages", "this"]
  let out = key
  let n = 2
  while (taken.has(out) || reserved.includes(out)) out = `${key}${n++}`
  return out
}

// Example values so the preview shows every box filled in.
export function placeholderData(schema, sample = {}) {
  const today = new Date().toISOString().slice(0, 10)
  const val = (f) => {
    if (f.type === "number") return 123
    if (f.type === "date") return today
    if (f.type === "select") return (f.options || [])[0] || ""
    if (f.type === "checkbox") return true
    if (f.type === "image") return ""
    return f.label
  }
  const out = {}
  for (const f of schema) {
    if (sample[f.key] !== undefined && sample[f.key] !== "" && !(Array.isArray(sample[f.key]) && !sample[f.key].length)) {
      out[f.key] = sample[f.key]
    } else if (f.type === "table") {
      out[f.key] = [1, 2, 3].map(() => Object.fromEntries(f.columns.map((c) => [c.key, val(c)])))
    } else out[f.key] = val(f)
  }
  return out
}

export async function pdfTemplateEditor(id, loaded) {
  const readOnly = !isAdmin()
  if (!id && readOnly) return go("#/templates")
  shell("templates", h("p", { class: "loading" }, "Loading…"))
  const [sys] = await Promise.all([api("GET", "/api/templates/system-items")])
  const SYSTEM = Object.fromEntries(sys.items.map((i) => [i.key, i]))

  const v = loaded && loaded.version
  const m = {
    name: loaded ? loaded.template.name : "",
    description: loaded ? loaded.template.description : "",
    schema: JSON.parse(JSON.stringify(v ? v.schema : [])),
    items: JSON.parse(JSON.stringify(v ? v.layout.items : [])),
    tables: JSON.parse(JSON.stringify(v ? v.layout.tables || {} : {})),
    pages: v ? v.layout.pages : null,
    // sourceHash: the form documents are printed on. originalHash: the PDF as
    // uploaded. They differ when text was erased from the form.
    sourceHash: v ? v.sourceHash : null,
    originalHash: v ? v.layout.originalSourceHash || v.sourceHash : null,
    settings: v ? { ...v.settings } : { numberPrefix: "", numberPadding: 4, sampleData: {} },
  }
  if (!m.settings.sampleData || typeof m.settings.sampleData !== "object") m.settings.sampleData = {}
  const sd = () => m.settings.sampleData
  // New boxes replace what's printed under them unless the admin turns this off.
  let eraseByDefault = true
  let dirty = false
  let selected = null
  let placing = null // { kind, key?, table?, column?, label }
  let zoom = 1
  let pdf = null
  let nextId = 1
  for (const it of m.items) {
    const n = Number(String(it.id).replace(/\D/g, ""))
    if (n >= nextId) nextId = n + 1
  }
  const newId = () => `b${nextId++}`
  let erasedSig = v && v.layout.originalSourceHash ? JSON.stringify(eraseAreas()) : ""
  const markDirty = () => { dirty = true }
  window.onbeforeunload = () => (dirty ? true : undefined)

  const err = h("div")
  const pagesHost = h("div", { class: "pdf-pages" })
  const side = h("aside", { class: "pdf-side" })
  const status = h("div", { class: "pdf-status" })
  const fieldOf = (key) => m.schema.find((f) => f.key === key)
  const itemLabel = (it) => {
    if (it.kind === "system") return SYSTEM[it.key] ? SYSTEM[it.key].label : it.key
    if (it.kind === "column") {
      const t = fieldOf(it.table)
      const c = it.column === "#" ? { label: "S/N" } : t && t.columns.find((x) => x.key === it.column)
      return `${t ? t.label : it.table} › ${c ? c.label : it.column}`
    }
    const f = fieldOf(it.key)
    return f ? f.label : it.key
  }

  // ---- Upload step (new template) ----
  async function uploadStep() {
    const input = h("input", { type: "file", accept: "application/pdf,.pdf", style: "display:none" })
    const drop = h("label", { class: "upload-drop" }, input,
      h("strong", {}, "Choose your PDF form"),
      h("span", { class: "muted" }, "or drag it here · up to 15 MB, 30 pages"))
    const uerr = h("div")
    const handle = async (file) => {
      if (!file) return
      uerr.replaceChildren()
      if (file.type && file.type !== "application/pdf") return uerr.replaceChildren(errorBox(new Error("That's not a PDF file")))
      drop.classList.add("busy")
      drop.querySelector("strong").textContent = `Uploading ${file.name}…`
      try {
        const res = await fetch("/api/templates/pdf-source", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/pdf" }, body: file })
        const data = await res.json()
        if (!res.ok) throw new ApiError(res.status, data)
        m.sourceHash = data.sourceHash
        m.originalHash = data.sourceHash
        m.pages = data.pages
        if (!m.name) m.name = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim()
        markDirty()
        await editorStep(data.formFields || [])
      } catch (e) {
        drop.classList.remove("busy")
        drop.querySelector("strong").textContent = "Choose your PDF form"
        uerr.replaceChildren(errorBox(e))
      }
    }
    input.addEventListener("change", () => handle(input.files[0]))
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over") })
    drop.addEventListener("dragleave", () => drop.classList.remove("over"))
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handle(e.dataTransfer.files[0]) })
    shell("templates",
      pageHead("Upload your PDF form", "Use a blank copy of the form. You'll then mark where each piece of information goes."),
      h("div", { class: "stack", style: "max-width:720px" },
        drop, uerr,
        h("div", { class: "card" }, h("h3", {}, "Tips"), h("ul", { class: "tips" },
          h("li", {}, "Use the original PDF from Word or your design software if you have it — it looks sharper than a scan."),
          h("li", {}, "Scans work too. Scan straight, at 300 dpi, on a clean blank form."),
          h("li", {}, "Leave a space for the QR code, e.g. in a corner of the header. You can place it anywhere."),
          h("li", {}, "If the PDF has fillable fields, we'll find them for you."),
          h("li", {}, "Only have a filled-in copy? Upload it anyway — tick “Erase what's printed under this box” on each box to remove the old information."))),
      ),
    )
  }

  // ---- Page rendering ----
  const pageEls = []
  async function drawPages() {
    pagesHost.replaceChildren()
    pageEls.length = 0
    if (!pdf) pdf = await openPdf(`/api/templates/pdf-source/${m.originalHash}`)
    const avail = Math.max(320, pagesHost.clientWidth - 8)
    const maxW = Math.max(...m.pages.map((p) => p.width))
    const scale = (avail / maxW) * zoom
    for (let i = 0; i < m.pages.length; i++) {
      const canvas = h("canvas", { class: "pdf-canvas" })
      const overlay = h("div", { class: "pdf-overlay", "data-page": i })
      const wrap = h("div", { class: "pdf-page", style: `width:${m.pages[i].width * scale}px;height:${m.pages[i].height * scale}px` },
        canvas, overlay, h("div", { class: "pdf-page-no" }, `Page ${i + 1} of ${m.pages.length}`))
      pagesHost.append(wrap)
      pageEls.push({ overlay, scale, canvas })
      if (!readOnly) attachDrawing(overlay, i)
      drawPdfPage(pdf, i, scale, canvas).catch((e) => toast(`Couldn't draw page ${i + 1}: ${e.message}`, true))
    }
    drawBoxes()
  }

  // ---- Example values shown in the boxes ----
  const fmtExample = (type, val) => {
    if (val === undefined || val === null || val === "" || val === false) return ""
    if (type === "checkbox") return "✓"
    if (type === "image") return ""
    if (type === "date") {
      const mm = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/)
      return mm ? `${mm[3]}/${mm[2]}/${mm[1]}` : String(val)
    }
    return String(val)
  }
  function exampleFor(it, row = 0) {
    const data = sd()
    if (it.kind === "field") {
      const f = fieldOf(it.key)
      return f ? fmtExample(f.type, data[it.key]) : ""
    }
    if (it.kind === "column") {
      const rows = Array.isArray(data[it.table]) ? data[it.table] : []
      if (!rows[row]) return ""
      if (it.column === "#") return String(row + 1)
      const t = fieldOf(it.table)
      const c = t && t.columns.find((x) => x.key === it.column)
      return c ? fmtExample(c.type, rows[row][c.key]) : ""
    }
    const pad = Math.max(1, m.settings.numberPadding || 4)
    return {
      "document.no": `${m.settings.numberPrefix || ""}${"1".padStart(pad, "0")}`,
      "approvedBy.name": "Awaiting approval",
      "preparedBy.name": state.me.name,
      "preparedBy.qualification": state.me.qualification || "",
      "org.name": state.org.name,
    }[it.key] || ""
  }
  const isMultiline = (it) => it.kind === "field" && (fieldOf(it.key) || {}).type === "textarea"
  const FAMILIES = { sans: "Helvetica, Arial, sans-serif", serif: "'Times New Roman', Times, serif", mono: "'Courier New', Courier, monospace" }
  function valueEl(it, text, s) {
    if (!text) return null
    const auto = isMultiline(it) ? Math.min(12, it.h * 0.72) : it.h * 0.72
    const size = Math.max(5, Math.min(it.fontSize || auto, it.h * 0.9)) * s
    const color = it.kind === "system" && it.key === "approvedBy.name" ? "#777" : it.color || "#0d0d1f"
    return h("span", {
      class: `pbox-value${isMultiline(it) ? " multi" : ""}`,
      style: `font-size:${size}px;font-family:${FAMILIES[it.font || "sans"]};font-weight:${it.bold ? 700 : 400};color:${color};` +
        `justify-content:${text === "✓" || it.align === "center" ? "center" : it.align === "right" ? "flex-end" : "flex-start"}`,
    }, text)
  }

  // ---- Boxes ----
  // `side: false` redraws only the page (keeps focus in the side panel while typing).
  function drawBoxes({ side = true } = {}) {
    for (const { overlay } of pageEls) overlay.querySelectorAll(".pbox,.pghost,.pcover").forEach((n) => n.remove())
    for (const it of m.items) {
      const pe = pageEls[it.page]
      if (!pe) continue
      const s = pe.scale
      const value = exampleFor(it)
      const cover = it.erase && it.kind === "column" ? `;background:${it.eraseColor || "#ffffff"}` : ""
      if (it.erase && it.kind !== "column") {
        const r = eraseRect(it)
        pe.overlay.append(h("div", { class: "pcover", style: `left:${r.x * s}px;top:${r.y * s}px;width:${r.w * s}px;height:${r.h * s}px;background:${it.eraseColor || "#ffffff"}` }))
      }
      const el = h("div", {
        class: `pbox k-${it.kind}${selected === it.id ? " sel" : ""}${value ? " has-value" : ""}${it.erase ? " erasing" : ""}`,
        style: `left:${it.x * s}px;top:${it.y * s}px;width:${it.w * s}px;height:${it.h * s}px${cover}`,
        title: itemLabel(it),
        "data-id": it.id,
      }, valueEl(it, value, s), h("span", { class: "pbox-label" }, itemLabel(it)), readOnly ? null : h("span", { class: "pbox-handle", "aria-hidden": "true" }))
      if (!readOnly) attachBox(el, it)
      pe.overlay.append(el)
      // Show where the following table rows will go, with example rows filled in.
      if (it.kind === "column") {
        const t = m.tables[it.table] || {}
        const rh = t.rowHeight || it.h
        const rows = Math.min(t.rowsPerPage || 1, 60)
        for (let r = 1; r < rows; r++) {
          if ((it.y + r * rh + it.h) > m.pages[it.page].height) break
          pe.overlay.append(h("div", { class: "pghost", style: `left:${it.x * s}px;top:${(it.y + r * rh) * s}px;width:${it.w * s}px;height:${it.h * s}px${cover}` },
            valueEl(it, exampleFor(it, r), s)))
        }
      }
    }
    if (side) drawSide()
  }

  const toPt = (overlay, e) => {
    const r = overlay.getBoundingClientRect()
    const s = pageEls[Number(overlay.dataset.page)].scale
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }
  }
  const snap = (n) => Math.round(n * 2) / 2
  const clampItem = (it) => {
    const pg = m.pages[it.page]
    it.w = Math.max(4, Math.min(it.w, pg.width))
    it.h = Math.max(4, Math.min(it.h, pg.height))
    it.x = snap(Math.max(0, Math.min(it.x, pg.width - it.w)))
    it.y = snap(Math.max(0, Math.min(it.y, pg.height - it.h)))
    it.w = snap(it.w)
    it.h = snap(it.h)
  }

  function attachDrawing(overlay, pageIndex) {
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target !== overlay || e.button !== 0) return
      e.preventDefault()
      overlay.setPointerCapture(e.pointerId)
      const start = toPt(overlay, e)
      const s = pageEls[pageIndex].scale
      const ghost = h("div", { class: "pdraw" })
      overlay.append(ghost)
      let rect = { x: start.x, y: start.y, w: 0, h: 0 }
      const move = (ev) => {
        const p = toPt(overlay, ev)
        rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }
        ghost.style.cssText = `left:${rect.x * s}px;top:${rect.y * s}px;width:${rect.w * s}px;height:${rect.h * s}px`
      }
      const up = async () => {
        overlay.removeEventListener("pointermove", move)
        overlay.removeEventListener("pointerup", up)
        ghost.remove()
        if (rect.w < 4 || rect.h < 4) {
          // A click: with something to place, drop a default-sized box here.
          if (placing) rect = { x: start.x, y: start.y - 7, w: placing.kind === "system" && placing.key === "qr" ? 60 : placing.w || 140, h: placing.kind === "system" && placing.key === "qr" ? 60 : placing.h || 14 }
          else { selected = null; drawBoxes(); return }
        }
        const item = { id: newId(), page: pageIndex, ...rect }
        if (placing) {
          Object.assign(item, { kind: placing.kind }, placing.kind === "column" ? { table: placing.table, column: placing.column } : { key: placing.key })
          placing = null
        } else {
          const ok = await newFieldDialog(item)
          if (!ok) return
        }
        clampItem(item)
        if (item.kind === "column") ensureTable(item)
        applyNewBoxDefaults(item)
        m.items.push(item)
        selected = item.id
        markDirty()
        drawBoxes()
      }
      overlay.addEventListener("pointermove", move)
      overlay.addEventListener("pointerup", up)
    })
  }

  function attachBox(el, it) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const resizing = e.target.classList.contains("pbox-handle")
      const overlay = el.parentElement
      const s = pageEls[it.page].scale
      const start = toPt(overlay, e)
      const orig = { ...it }
      let moved = false
      if (selected !== it.id) {
        selected = it.id
        overlay.querySelectorAll(".pbox.sel").forEach((n) => n.classList.remove("sel"))
        el.classList.add("sel")
        drawSide()
      }
      el.setPointerCapture(e.pointerId)
      const move = (ev) => {
        const p = toPt(overlay, ev)
        const dx = p.x - start.x
        const dy = p.y - start.y
        if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true
        if (resizing) { it.w = orig.w + dx; it.h = orig.h + dy } else { it.x = orig.x + dx; it.y = orig.y + dy }
        clampItem(it)
        el.style.cssText = `left:${it.x * s}px;top:${it.y * s}px;width:${it.w * s}px;height:${it.h * s}px`
      }
      const up = () => {
        el.removeEventListener("pointermove", move)
        el.removeEventListener("pointerup", up)
        if (moved) {
          if (it.kind === "column") syncTableRow(it, orig)
          markDirty()
          drawBoxes()
        }
      }
      el.addEventListener("pointermove", move)
      el.addEventListener("pointerup", up)
    })
  }

  // Table columns share a first-row line and row height.
  function ensureTable(item) {
    const t = m.tables[item.table] || (m.tables[item.table] = {})
    if (!t.rowHeight) t.rowHeight = item.h
    const sibling = m.items.find((i) => i.kind === "column" && i.table === item.table && i.id !== item.id)
    if (sibling) {
      item.page = sibling.page
      item.y = sibling.y
      item.h = sibling.h
    }
    if (!t.rowsPerPage) {
      // Start with 10 rows (or fewer if the page ends first); the admin adjusts it to match the form.
      t.rowsPerPage = Math.max(1, Math.min(10, Math.floor((m.pages[item.page].height - item.y) / t.rowHeight)))
    }
  }
  function syncTableRow(it, orig) {
    if (it.y === orig.y && it.h === orig.h) return
    for (const c of m.items) if (c.kind === "column" && c.table === it.table && c.id !== it.id) { c.y = it.y; c.h = it.h }
    const t = m.tables[it.table]
    if (t && it.h > t.rowHeight) t.rowHeight = it.h
  }

  // ---- "What goes in this box?" ----
  async function newFieldDialog(item) {
    const taken = new Set(m.schema.map((f) => f.key))
    const unplacedFields = m.schema.filter((f) => f.type !== "table" && !m.items.some((i) => i.kind === "field" && i.key === f.key))
    const unplacedSystem = Object.values(SYSTEM).filter((si) => !m.items.some((i) => i.kind === "system" && i.key === si.key))
    const tables = m.schema.filter((f) => f.type === "table")

    const what = h("select", { name: "what" },
      h("option", { value: "new" }, "A new field"),
      unplacedFields.length ? h("optgroup", { label: "Existing fields" }, unplacedFields.map((f) => h("option", { value: `field:${f.key}` }, f.label))) : null,
      h("optgroup", { label: "Filled in automatically" }, unplacedSystem.map((si) => h("option", { value: `system:${si.key}` }, si.label))),
      h("option", { value: "column" }, "A column of a table (repeating rows)"),
    )
    const label = h("input", { name: "label", placeholder: "e.g. Client name", autocomplete: "off" })
    const type = h("select", { name: "type" }, Object.entries(TYPE_LABELS).map(([k, l]) => h("option", { value: k }, l)))
    const options = h("input", { name: "options", placeholder: "e.g. PASS, FAIL" })
    const required = h("input", { type: "checkbox", name: "required", checked: true })
    const onVerify = h("input", { type: "checkbox", name: "showOnVerify" })
    const tableSel = h("select", { name: "table" }, tables.map((t) => h("option", { value: t.key }, t.label)), h("option", { value: "__new" }, "New table…"))
    const tableName = h("input", { name: "tableName", placeholder: "e.g. Items tested" })
    const colType = h("select", { name: "colType" }, h("option", { value: "#" }, "Row number (S/N)"), COL_TYPES.map((k) => h("option", { value: k, selected: k === "text" ? true : null }, TYPE_LABELS[k])))

    const rowNew = [h("label", { class: "field" }, h("span", {}, "Name of the field"), label),
      h("label", { class: "field" }, h("span", {}, "Type"), type)]
    const rowOptions = h("label", { class: "field" }, h("span", {}, "Choices (comma separated)"), options)
    const rowFlags = h("div", { class: "row" }, h("label", { class: "check" }, required, "Required"), h("label", { class: "check" }, onVerify, "Show on verify page"))
    const rowTable = h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Table"), tableSel),
      h("label", { class: "field", "data-newtable": "" }, h("span", {}, "Table name"), tableName),
      h("label", { class: "field" }, h("span", {}, "Column type"), colType),
      h("label", { class: "field", "data-colname": "" }, h("span", {}, "Column name"), h("input", { name: "colLabel", placeholder: "e.g. Description" })),
      h("p", { class: "muted", style: "font-size:.85rem;margin:0" }, "Draw the box on the first row. Rows below follow automatically."),
    )
    const body = h("div", { class: "stack" }, h("label", { class: "field" }, h("span", {}, "Fill this box with"), what), ...rowNew, rowOptions, rowFlags, rowTable)
    const sync = () => {
      const w = what.value
      const isNew = w === "new"
      const isCol = w === "column"
      rowNew.forEach((n) => { n.hidden = !isNew })
      rowOptions.hidden = !(isNew && type.value === "select")
      rowFlags.hidden = !isNew
      rowTable.hidden = !isCol
      rowTable.querySelector("[data-newtable]").hidden = tableSel.value !== "__new"
      rowTable.querySelector("[data-colname]").hidden = colType.value === "#"
      const ctOpt = colType.querySelector('option[value="select"]')
      if (ctOpt) ctOpt.textContent = "Dropdown (add choices later)"
    }
    ;[what, type, tableSel, colType].forEach((n) => n.addEventListener("change", sync))
    if (!tables.length) tableSel.value = "__new"
    sync()
    setTimeout(() => label.focus(), 50)

    const res = await modal("What goes in this box?", [body], { submitLabel: "Add" })
    if (!res) return false
    if (res.what.startsWith("field:")) Object.assign(item, { kind: "field", key: res.what.slice(6) })
    else if (res.what.startsWith("system:")) Object.assign(item, { kind: "system", key: res.what.slice(7) })
    else if (res.what === "column") {
      let tkey = res.table
      if (!tkey || tkey === "__new") {
        const tl = (res.tableName || "").trim() || "Items"
        tkey = keyFromLabel(tl, taken)
        m.schema.push({ key: tkey, label: tl, type: "table", required: true, columns: [] })
        taken.add(tkey)
      }
      const t = fieldOf(tkey)
      let ckey = "#"
      if (res.colType !== "#") {
        const cl = (res.colLabel || "").trim() || `Column ${t.columns.length + 1}`
        ckey = keyFromLabel(cl, new Set(t.columns.map((c) => c.key)))
        const col = { key: ckey, label: cl, type: res.colType }
        if (res.colType === "select") col.options = ["Option 1", "Option 2"]
        t.columns.push(col)
      }
      Object.assign(item, { kind: "column", table: tkey, column: ckey })
    } else {
      const l = (res.label || "").trim()
      if (!l) { toast("Give the field a name", true); return false }
      const f = { key: keyFromLabel(l, taken), label: l, type: res.type, required: Boolean(res.required) && res.type !== "checkbox" }
      if (res.showOnVerify && !["image", "checkbox"].includes(res.type)) f.showOnVerify = true
      if (res.type === "select") {
        f.options = String(res.options || "").split(",").map((o) => o.trim()).filter(Boolean)
        if (!f.options.length) f.options = ["Option 1", "Option 2"]
      }
      m.schema.push(f)
      Object.assign(item, { kind: "field", key: f.key })
      if (res.type === "textarea" && item.h < 24) item.h = 36
    }
    return true
  }

  // ---- Side panel ----
  function drawSide() {
    const sel = m.items.find((i) => i.id === selected)
    const parts = []

    if (!readOnly) {
      parts.push(h("div", { class: "card pdf-hint" }, placing
        ? [h("strong", {}, `Placing: ${placing.label}`), h("p", { class: "muted", style: "margin:4px 0 8px" }, "Click on the page, or drag to draw the box."), h("button", { class: "btn small", onclick: () => { placing = null; drawSide() } }, "Cancel")]
        : [h("strong", {}, "Drag on the page to add a box"),
          h("p", { class: "muted", style: "margin:4px 0 0" }, "Draw where the information should be printed, then say what goes there. Drag boxes to move them; drag the corner to resize."),
          h("label", { class: "check", style: "margin-top:10px;font-size:.9rem" },
            h("input", { type: "checkbox", checked: eraseByDefault, onchange: (e) => { eraseByDefault = e.target.checked } }),
            "New boxes replace what's printed under them"),
          h("p", { class: "muted", style: "margin:8px 0 0;font-size:.85rem" }, "Values you type here are only examples to check the layout. Your team enters the real values on each document (Documents → New document), then sends it for approval.")]))
    }

    if (sel && !readOnly) parts.push(propsPanel(sel))

    // Fields
    const fieldRows = m.schema.map((f) => {
      if (f.type === "table") {
        const cols = [{ key: "#", label: "S/N (row number)" }, ...f.columns]
        return h("div", { class: "fl-item" },
          h("div", { class: "fl-head" }, h("strong", {}, f.label), h("span", { class: "muted" }, " · table")),
          cols.map((c) => {
            const placed = m.items.find((i) => i.kind === "column" && i.table === f.key && i.column === c.key)
            if (c.key === "#" && !placed && readOnly) return null
            return h("div", { class: "fl-sub" }, h("span", {}, c.label),
              placed ? h("button", { class: "chip ok", onclick: () => select(placed.id) }, "placed")
                : readOnly ? h("span", { class: "chip" }, "not placed")
                  : h("button", { class: "chip", onclick: () => startPlacing({ kind: "column", table: f.key, column: c.key, label: `${f.label} › ${c.label}`, w: 80, h: (m.tables[f.key] || {}).rowHeight || 16 }) }, "place"))
          }))
      }
      const placed = m.items.filter((i) => i.kind === "field" && i.key === f.key)
      return h("div", { class: "fl-item" },
        h("div", { class: "fl-head" }, h("strong", {}, f.label), h("span", { class: "muted" }, ` · ${TYPE_LABELS[f.type] || f.type}${f.required ? " · required" : ""}`)),
        h("div", { class: "fl-sub" },
          placed.length ? h("button", { class: "chip ok", onclick: () => select(placed[0].id) }, `on page ${placed[0].page + 1}`) : h("span", { class: "chip warn" }, "not on the page"),
          !readOnly ? h("button", { class: "chip", onclick: () => startPlacing({ kind: "field", key: f.key, label: f.label, w: f.type === "checkbox" ? 12 : 140, h: f.type === "checkbox" ? 12 : f.type === "textarea" ? 36 : 14 }) }, placed.length ? "place again" : "place") : null))
    })
    parts.push(h("div", { class: "card" }, h("h3", {}, `Fields (${m.schema.length})`),
      m.schema.length ? h("div", { class: "fl-list" }, fieldRows) : h("p", { class: "muted" }, "None yet. Draw a box on the page to add one.")))

    // Example values
    if (!readOnly && m.schema.length) {
      parts.push(h("div", { class: "card" }, h("h3", {}, "Example values"),
        h("p", { class: "muted", style: "font-size:.85rem" }, "Shown in the boxes and in Preview, and offered as “Fill with sample data” on new documents."),
        h("button", { class: "btn small", onclick: editExamples }, "Edit example values")))
    }

    // System items
    parts.push(h("div", { class: "card" }, h("h3", {}, "Filled in automatically"),
      h("p", { class: "muted", style: "font-size:.85rem" }, "Place the QR code and signatures where they belong. They're filled in when a document is issued."),
      h("div", { class: "fl-list" }, Object.values(SYSTEM).map((si) => {
        const placed = m.items.find((i) => i.kind === "system" && i.key === si.key)
        if (readOnly && !placed) return null
        return h("div", { class: "fl-sub" }, h("span", {}, si.label, si.key === "qr" ? h("span", { class: "req" }, " *") : null),
          placed ? h("button", { class: "chip ok", onclick: () => select(placed.id) }, "placed")
            : h("button", { class: "chip", onclick: () => startPlacing({ kind: "system", key: si.key, label: si.label, w: si.type === "image" ? 110 : si.key === "qr" ? 60 : 140, h: si.type === "image" ? 30 : si.key === "qr" ? 60 : 14 }) }, "place"))
      }))))

    // Settings
    if (!readOnly) {
      parts.push(h("div", { class: "card stack" }, h("h3", {}, "Template"),
        h("label", { class: "field" }, h("span", {}, "Name"), h("input", { value: m.name, oninput: (e) => { m.name = e.target.value; markDirty() } })),
        h("label", { class: "field" }, h("span", {}, "Description"), h("textarea", { rows: 2, value: m.description, oninput: (e) => { m.description = e.target.value; markDirty() } })),
        h("div", { class: "grid-2" },
          h("label", { class: "field" }, h("span", {}, "Number prefix"), h("input", { value: m.settings.numberPrefix || "", placeholder: "e.g. PT/", oninput: (e) => { m.settings.numberPrefix = e.target.value; markDirty() } })),
          h("label", { class: "field" }, h("span", {}, "Digits"), h("input", { type: "number", min: 1, max: 8, value: m.settings.numberPadding || 4, oninput: (e) => { m.settings.numberPadding = Number(e.target.value); markDirty() } })))))
    }
    side.replaceChildren(...parts)
  }

  function select(itemId) {
    selected = itemId
    const it = m.items.find((i) => i.id === itemId)
    drawBoxes()
    const el = pagesHost.querySelector(`.pbox[data-id="${itemId}"]`)
    if (el && it) el.scrollIntoView({ block: "center", behavior: "smooth" })
  }

  function startPlacing(p) {
    placing = p
    selected = null
    drawBoxes()
    toast("Now click on the page where it goes")
  }

  function propsPanel(it) {
    const del = () => {
      m.items = m.items.filter((i) => i.id !== it.id)
      selected = null
      markDirty()
      drawBoxes()
    }
    const rows = [h("div", { class: "row" }, h("h3", { style: "margin:0" }, itemLabel(it)), h("div", { class: "spacer" }), h("button", { class: "btn small ghost", onclick: () => { selected = null; drawBoxes() } }, "✕"))]

    if (it.kind === "field") {
      const f = fieldOf(it.key)
      rows.push(
        h("label", { class: "field" }, h("span", {}, "Field name"), h("input", { value: f.label, oninput: (e) => { f.label = e.target.value; markDirty(); pagesHost.querySelectorAll(`.pbox[data-id="${it.id}"] .pbox-label`).forEach((n) => { n.textContent = f.label }) } })),
        h("label", { class: "field" }, h("span", {}, "Type"), h("select", { onchange: (e) => {
          f.type = e.target.value
          if (f.type === "select" && !f.options) f.options = ["Option 1", "Option 2"]
          if (f.type === "checkbox") f.required = false
          markDirty(); drawSide()
        } }, Object.entries(TYPE_LABELS).map(([k, l]) => h("option", { value: k, selected: k === f.type ? true : null }, l)))),
        f.type === "select" ? h("label", { class: "field" }, h("span", {}, "Choices (comma separated)"), h("input", { value: (f.options || []).join(", "), onchange: (e) => { f.options = e.target.value.split(",").map((o) => o.trim()).filter(Boolean); markDirty() } })) : null,
        h("div", { class: "row" },
          f.type !== "checkbox" ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.required, onchange: (e) => { f.required = e.target.checked; markDirty() } }), "Required") : null,
          !["image", "checkbox"].includes(f.type) ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.showOnVerify, onchange: (e) => { f.showOnVerify = e.target.checked; markDirty() } }), "Show on verify page") : null),
      )
    }
    if (it.kind === "column" && it.column !== "#") {
      const t = fieldOf(it.table)
      const c = t.columns.find((x) => x.key === it.column)
      rows.push(
        h("label", { class: "field" }, h("span", {}, "Column name"), h("input", { value: c.label, oninput: (e) => { c.label = e.target.value; markDirty() } })),
        h("label", { class: "field" }, h("span", {}, "Type"), h("select", { onchange: (e) => { c.type = e.target.value; if (c.type === "select" && !c.options) c.options = ["Option 1", "Option 2"]; markDirty(); drawSide() } },
          COL_TYPES.map((k) => h("option", { value: k, selected: k === c.type ? true : null }, TYPE_LABELS[k])))),
        c.type === "select" ? h("label", { class: "field" }, h("span", {}, "Choices (comma separated)"), h("input", { value: (c.options || []).join(", "), onchange: (e) => { c.options = e.target.value.split(",").map((o) => o.trim()).filter(Boolean); markDirty() } })) : null,
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: c.required, onchange: (e) => { c.required = e.target.checked; markDirty() } }), "Required"),
      )
    }
    if (it.kind === "column") {
      const t = m.tables[it.table] || (m.tables[it.table] = { rowHeight: it.h, rowsPerPage: 10 })
      rows.push(h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", {}, "Row spacing (pt)"), h("input", { type: "number", step: "0.5", min: 4, value: t.rowHeight, onchange: (e) => { t.rowHeight = Number(e.target.value) || it.h; markDirty(); drawBoxes() } })),
        h("label", { class: "field" }, h("span", {}, "Rows per page"), h("input", { type: "number", min: 1, max: 200, value: t.rowsPerPage, onchange: (e) => { t.rowsPerPage = Math.max(1, Number(e.target.value) || 1); markDirty(); drawBoxes() } }))),
        h("p", { class: "muted", style: "font-size:.82rem;margin:0" }, "Set these so the dashed boxes line up with the rows printed on your form. Rows beyond this continue on a copy of the page."))
    }
    if (it.kind !== "system" || !["qr", "org.logo", "preparedBy.signature", "approvedBy.signature"].includes(it.key)) {
      const f = it.kind === "field" ? fieldOf(it.key) : null
      if (!f || !["checkbox", "image"].includes(f.type)) {
        rows.push(h("div", { class: "grid-2" },
          h("label", { class: "field" }, h("span", {}, "Text size"), h("select", { onchange: (e) => { it.fontSize = e.target.value ? Number(e.target.value) : undefined; markDirty(); drawBoxes({ side: false }) } },
            h("option", { value: "" }, "Auto (fill the box)"), [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36].map((n) => h("option", { value: n, selected: it.fontSize === n ? true : null }, `${n} pt`)))),
          h("label", { class: "field" }, h("span", {}, "Align"), h("select", { onchange: (e) => { it.align = e.target.value; markDirty(); drawBoxes({ side: false }) } },
            ["left", "center", "right"].map((a) => h("option", { value: a, selected: (it.align || "left") === a ? true : null }, a[0].toUpperCase() + a.slice(1))))),
          h("label", { class: "field" }, h("span", {}, "Font"), h("select", { onchange: (e) => { it.font = e.target.value === "sans" ? undefined : e.target.value; markDirty(); drawBoxes({ side: false }) } },
            [["sans", "Sans (Helvetica)"], ["serif", "Serif (Times)"], ["mono", "Mono (Courier)"]].map(([k, l]) => h("option", { value: k, selected: (it.font || "sans") === k ? true : null }, l)))),
          h("div", { class: "field" }, h("span", { class: "flabel" }, "Text colour"),
            h("div", { class: "row", style: "gap:6px" },
              h("input", { type: "color", class: "color-in", value: it.color || "#0d0d1f", "aria-label": "Text colour", oninput: (e) => { it.color = e.target.value; markDirty(); drawBoxes({ side: false }) } }),
              h("button", { class: "btn small", title: "Use the colour of the text printed here on the form", onclick: () => { const { ink } = sampleColors(it); if (ink) { it.color = ink; markDirty(); drawBoxes() } else toast("No text found under this box to match") } }, "Match"))),
          h("label", { class: "check full" }, h("input", { type: "checkbox", checked: it.bold, onchange: (e) => { it.bold = e.target.checked || undefined; markDirty(); drawBoxes({ side: false }) } }), "Bold")))
      }
    }
    // Example value for this box
    const exampleInput = (type, options, get, set) => {
      const onValue = (val) => { set(val); markDirty(); drawBoxes({ side: false }) }
      let input
      if (type === "checkbox") {
        return h("label", { class: "check" }, h("input", { type: "checkbox", checked: Boolean(get()), onchange: (e) => onValue(e.target.checked) }), "Example: ticked")
      } else if (type === "select") {
        input = h("select", { onchange: (e) => onValue(e.target.value) }, h("option", { value: "" }, "—"), (options || []).map((o) => h("option", { value: o, selected: o === get() ? true : null }, o)))
      } else if (type === "textarea") {
        input = h("textarea", { rows: 2, value: get() || "", oninput: (e) => onValue(e.target.value) })
      } else {
        input = h("input", { type: type === "number" ? "number" : type === "date" ? "date" : "text", value: get() ?? "", oninput: (e) => onValue(e.target.value) })
      }
      return h("label", { class: "field" }, h("span", {}, "Example value"), input)
    }
    if (it.kind === "field") {
      const f = fieldOf(it.key)
      if (f && f.type !== "image") rows.push(exampleInput(f.type, f.options, () => sd()[f.key], (val) => { sd()[f.key] = val }))
    }
    if (it.kind === "column" && it.column !== "#") {
      const t = fieldOf(it.table)
      const c = t && t.columns.find((x) => x.key === it.column)
      if (c) {
        rows.push(exampleInput(c.type, c.options, () => ((sd()[t.key] || [])[0] || {})[c.key], (val) => {
          if (!Array.isArray(sd()[t.key]) || !sd()[t.key].length) sd()[t.key] = [{}]
          sd()[t.key][0][c.key] = val
        }))
      }
    }
    if (it.kind === "system" && it.key.startsWith("approvedBy.")) {
      rows.push(h("p", { class: "muted", style: "font-size:.82rem;margin:0" }, "Filled in when an approver approves the document. Until then drafts show “Awaiting approval” here."))
    } else if (it.kind === "system" && it.key.startsWith("preparedBy.")) {
      rows.push(h("p", { class: "muted", style: "font-size:.82rem;margin:0" }, "Filled in from the profile of the person who prepares the document (Settings → Your profile)."))
    }

    // Erase what's printed underneath
    rows.push(h("div", { class: "erase-box" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: it.erase, onchange: (e) => {
        it.erase = e.target.checked
        if (it.erase && !it.eraseColor) it.eraseColor = sampleColor(it)
        markDirty()
        drawBoxes()
      } }), "Erase what's printed under this box"),
      it.erase
        ? h("div", { class: "row", style: "margin-top:6px" },
            h("input", { type: "color", value: it.eraseColor || "#ffffff", "aria-label": "Cover colour", class: "color-in", oninput: (e) => { it.eraseColor = e.target.value; markDirty(); drawBoxes({ side: false }) } }),
            h("button", { class: "btn small", onclick: () => { it.eraseColor = sampleColor(it); markDirty(); drawBoxes() } }, "Match the page colour"))
        : null,
      h("p", { class: "muted", style: "font-size:.8rem;margin:6px 0 0" }, it.kind === "column"
        ? "Clears this column in every row. Use it when your PDF already has old information here — it's removed from the form, not just hidden."
        : "Use it when your PDF already has old information here — it's removed from the form, not just hidden.")))

    rows.push(h("div", { class: "row" },
      h("button", { class: "btn small danger", onclick: del }, "Remove box"),
      it.kind === "field" ? h("button", { class: "btn small ghost", onclick: () => {
        m.schema = m.schema.filter((f) => f.key !== it.key)
        m.items = m.items.filter((i) => !(i.kind === "field" && i.key === it.key))
        selected = null; markDirty(); drawBoxes()
      } }, "Delete field") : null))
    rows.push(h("p", { class: "muted", style: "font-size:.78rem;margin:0" }, `Page ${it.page + 1} · x ${it.x} · y ${it.y} · ${it.w} × ${it.h} pt. Arrow keys nudge; Delete removes.`))
    return h("div", { class: "card stack props" }, rows)
  }

  // Keyboard: nudge / delete the selected box.
  const onKey = (e) => {
    if (!selected || readOnly) return
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement && document.activeElement.tagName)) return
    const it = m.items.find((i) => i.id === selected)
    if (!it) return
    const step = e.shiftKey ? 5 : 0.5
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    if (moves[e.key]) {
      e.preventDefault()
      const orig = { ...it }
      it.x += moves[e.key][0]
      it.y += moves[e.key][1]
      clampItem(it)
      if (it.kind === "column") syncTableRow(it, orig)
      markDirty()
      drawBoxes()
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault()
      m.items = m.items.filter((i) => i.id !== it.id)
      selected = null
      markDirty()
      drawBoxes()
    } else if (e.key === "Escape") {
      selected = null
      placing = null
      drawBoxes()
    }
  }
  document.addEventListener("keydown", onKey)
  window.addEventListener("hashchange", () => document.removeEventListener("keydown", onKey), { once: true })

  // ---- Erasing what's printed under boxes ----
  // Reads the page under a box: the background colour (most common colour) and
  // the text colour (most common colour clearly different from it), so the
  // cover blends in and the new text looks like the text it replaces.
  function sampleColors(it) {
    const fallback = { bg: "#ffffff", ink: null }
    try {
      const pe = pageEls[it.page]
      const c = pe && pe.canvas
      if (!c || !c.width) return fallback
      const k = c.width / m.pages[it.page].width
      const x0 = Math.max(0, Math.floor(it.x * k))
      const y0 = Math.max(0, Math.floor(it.y * k))
      const w = Math.max(1, Math.min(c.width - x0, Math.ceil(it.w * k)))
      const hh = Math.max(1, Math.min(c.height - y0, Math.ceil(it.h * k)))
      const data = c.getContext("2d").getImageData(x0, y0, w, hh).data
      const buckets = new Map()
      const step = Math.max(1, Math.floor(Math.sqrt((w * hh) / 6000)))
      for (let yy = 0; yy < hh; yy += step) {
        for (let xx = 0; xx < w; xx += step) {
          const i = (yy * w + xx) * 4
          const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
          const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
          b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]
          buckets.set(key, b)
        }
      }
      const avg = (b) => [b.r / b.n, b.g / b.n, b.b / b.n]
      const hex = (rgbv) => `#${rgbv.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`
      const list = [...buckets.values()].sort((a, b) => b.n - a.n)
      const bg = avg(list[0])
      const dist = (a) => Math.hypot(a[0] - bg[0], a[1] - bg[1], a[2] - bg[2])
      const inkBucket = list.slice(1).find((b) => b.n >= 3 && dist(avg(b)) > 110)
      return { bg: hex(bg), ink: inkBucket ? hex(avg(inkBucket)) : null }
    } catch {
      return fallback
    }
  }
  const sampleColor = (it) => sampleColors(it).bg

  // The erased area reaches a little past the box, most of all downwards,
  // so the tails of old letters (g, j, p, y) below the drawn box go too.
  function eraseRect(it, y = it.y) {
    const pg = m.pages[it.page]
    const x = Math.max(0, it.x - 1.5)
    const top = Math.max(0, y - 1.5)
    const w = Math.min(pg.width - x, it.w + 3)
    const hh = Math.min(pg.height - top, it.h + 3 + it.h * 0.22)
    return { x, y: top, w, h: hh }
  }

  function applyNewBoxDefaults(item) {
    if (!eraseByDefault) return
    const { bg, ink } = sampleColors(item)
    item.erase = true
    item.eraseColor = bg
    const isText = !(item.kind === "system" && ["qr", "org.logo", "preparedBy.signature", "approvedBy.signature"].includes(item.key)) &&
      !(item.kind === "field" && ["checkbox", "image"].includes((fieldOf(item.key) || {}).type))
    if (isText && ink) item.color = ink
  }

  function eraseAreas() {
    const areas = []
    for (const it of m.items) {
      if (!it.erase) continue
      const color = it.eraseColor || "#ffffff"
      if (it.kind === "column") {
        const t = m.tables[it.table] || {}
        const rh = t.rowHeight || it.h
        const rows = Math.max(1, t.rowsPerPage || 1)
        for (let r = 0; r < rows; r++) {
          const y = it.y + r * rh
          if (y + it.h > m.pages[it.page].height + 0.5) break
          // Table cells: stay inside the row so ruled lines survive.
          areas.push({ page: it.page, x: it.x + 1, y: y + 1, w: it.w - 2, h: it.h - 2, color })
        }
      } else areas.push({ page: it.page, ...eraseRect(it), color })
    }
    return areas
  }

  async function loadPdfLib() {
    if (window.PDFLib) return window.PDFLib
    await new Promise((resolve, reject) => {
      const tag = document.createElement("script")
      tag.src = "/vendor/pdf-lib/pdf-lib.min.js"
      tag.onload = resolve
      tag.onerror = () => reject(new Error("Couldn't load the PDF tools"))
      document.head.append(tag)
    })
    return window.PDFLib
  }

  // Builds a copy of the uploaded form with the erase areas painted out, and
  // uploads it as the form documents are printed on. Pages without erase
  // areas are copied as they are; pages with them are redrawn as an image
  // (216 dpi), so the old text is really gone rather than hidden.
  async function ensureCleanSource() {
    const areas = eraseAreas()
    const sig = JSON.stringify(areas)
    if (!areas.length) {
      m.sourceHash = m.originalHash
      erasedSig = ""
      return
    }
    if (sig === erasedSig && m.sourceHash && m.sourceHash !== m.originalHash) return
    const PDFLib = await loadPdfLib()
    const origBytes = await (await fetch(`/api/templates/pdf-source/${m.originalHash}`, { credentials: "same-origin" })).arrayBuffer()
    const src = await PDFLib.PDFDocument.load(origBytes)
    const out = await PDFLib.PDFDocument.create()
    if (!pdf) pdf = await openPdf(`/api/templates/pdf-source/${m.originalHash}`)
    const K = 3
    for (let i = 0; i < m.pages.length; i++) {
      const mine = areas.filter((a) => a.page === i)
      if (!mine.length) {
        const [copied] = await out.copyPages(src, [i])
        out.addPage(copied)
        continue
      }
      const page = await pdf.getPage(i + 1)
      const vp = page.getViewport({ scale: K })
      const canvas = document.createElement("canvas")
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      const ctx = canvas.getContext("2d")
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp }).promise
      for (const a of mine) {
        ctx.fillStyle = a.color
        ctx.fillRect(a.x * K - 1, a.y * K - 1, a.w * K + 2, a.h * K + 2)
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
      const img = await out.embedPng(await blob.arrayBuffer())
      const pg = out.addPage([m.pages[i].width, m.pages[i].height])
      pg.drawImage(img, { x: 0, y: 0, width: m.pages[i].width, height: m.pages[i].height })
    }
    const bytes = await out.save()
    const res = await fetch("/api/templates/pdf-source", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/pdf" }, body: bytes })
    const data = await res.json()
    if (!res.ok) throw new ApiError(res.status, data)
    m.sourceHash = data.sourceHash
    erasedSig = sig
  }

  const layoutBody = () => ({
    items: m.items,
    tables: m.tables,
    originalSourceHash: m.sourceHash !== m.originalHash ? m.originalHash : undefined,
  })

  async function editExamples() {
    const form = buildForm(m.schema, sd())
    const ok = await modal("Example values", [h("p", { class: "muted" }, "Used to check the layout, in Preview, and for “Fill with sample data” on new documents. Real values are entered on each document."), form.el], { submitLabel: "Use these values", wide: true })
    if (!ok) return
    m.settings.sampleData = form.values()
    markDirty()
    drawBoxes()
  }

  // ---- Preview & save ----
  async function preview(btn) {
    await busy(btn, async () => {
      await ensureCleanSource()
      const r = await api("POST", "/api/templates/preview", {
        kind: "pdf", sourceHash: m.sourceHash, schema: m.schema, layout: layoutBody(),
        data: placeholderData(m.schema, m.settings.sampleData || {}),
      })
      const host = h("div", { class: "pdf-scroll", style: "height:70vh" })
      const dlg = h("dialog", { class: "wide" }, h("div", { style: "padding:16px" },
        h("div", { class: "row", style: "margin-bottom:10px" }, h("h2", { style: "margin:0" }, "Preview"), h("span", { class: "muted" }, "with example values"), h("div", { class: "spacer" }),
          h("button", { class: "btn", onclick: () => dlg.close() }, "Close")), host))
      dlg.addEventListener("close", () => dlg.remove())
      document.body.append(dlg)
      dlg.showModal()
      const res = await fetch(r.previewUrl, { credentials: "same-origin" })
      await renderPdfPages(host, await res.arrayBuffer())
    }, err)
  }

  async function save(btn) {
    await busy(btn, async () => {
      if (!m.name.trim()) throw new Error("Give the template a name (in the panel on the right)")
      if (!m.items.some((i) => i.kind === "system" && i.key === "qr")) {
        const ok = await modal("No QR code on the page", [h("p", {}, "Partners scan the QR code to verify a document. Save without it?")], { submitLabel: "Save anyway" })
        if (!ok) return
      }
      await ensureCleanSource()
      const body = { kind: "pdf", sourceHash: m.sourceHash, schema: m.schema, layout: layoutBody(), settings: m.settings }
      let r
      if (!id) {
        r = await api("POST", "/api/templates", { name: m.name, description: m.description, ...body })
      } else {
        if (m.name !== loaded.template.name || m.description !== loaded.template.description) {
          await api("PATCH", `/api/templates/${id}`, { name: m.name, description: m.description })
        }
        r = await api("POST", `/api/templates/${id}/versions`, body)
      }
      dirty = false
      state.templates = null
      const note = r.unplaced && r.unplaced.length ? ` Not on the page yet: ${r.unplaced.join(", ")}.` : ""
      toast(`${!id ? "Template created." : r.unchanged ? "No changes." : `Saved as version ${r.version.version}.`}${note}`)
      go(`#/templates/${r.template.id}`, true)
    }, err)
  }

  // ---- Main editor screen ----
  async function editorStep(formFields = []) {
    const previewBtn = h("button", { class: "btn", onclick: (e) => preview(e.currentTarget) }, "Preview")
    const saveBtn = readOnly ? null : h("button", { class: "btn primary", onclick: (e) => save(e.currentTarget) }, id ? "Save new version" : "Create template")
    const zoomCtl = h("div", { class: "row zoom" },
      h("button", { class: "btn small", "aria-label": "Zoom out", onclick: () => { zoom = Math.max(0.5, zoom - 0.25); drawPages() } }, "−"),
      h("button", { class: "btn small", onclick: () => { zoom = 1; drawPages() } }, "Fit"),
      h("button", { class: "btn small", "aria-label": "Zoom in", onclick: () => { zoom = Math.min(3, zoom + 0.25); drawPages() } }, "+"))
    const detected = formFields.length && !readOnly
      ? h("div", { class: "notice info row" },
          h("span", {}, `This PDF has ${formFields.length} fillable field${formFields.length === 1 ? "" : "s"}. Add them automatically?`),
          h("div", { class: "spacer" }),
          h("button", { class: "btn small primary", onclick: (e) => {
            const taken = new Set(m.schema.map((f) => f.key))
            for (const ff of formFields) {
              const f = { key: keyFromLabel(ff.label, taken), label: ff.label, type: ff.type }
              if (ff.options) f.options = ff.options
              taken.add(f.key)
              m.schema.push(f)
              m.items.push({ id: newId(), kind: "field", key: f.key, page: ff.page, x: ff.x, y: ff.y, w: Math.max(4, ff.w), h: Math.max(4, ff.h) })
            }
            markDirty()
            e.currentTarget.closest(".notice").remove()
            drawBoxes()
            toast(`${formFields.length} fields added — check their names and types`)
          } }, "Add them"))
      : null

    shell("templates",
      pageHead(id ? m.name : "Mark the fields on your form", id ? `PDF form · version ${v.version}. Saving creates a new version — documents already issued keep theirs.` : "Drag a box wherever information should be printed. Place the QR code too.",
        id ? h("a", { class: "btn", href: `#/documents/new/${id}` }, "New document") : null, previewBtn, saveBtn),
      err, detected,
      h("div", { class: "pdf-editor" },
        h("div", { class: "pdf-main" }, h("div", { class: "row", style: "margin-bottom:8px" }, status, h("div", { class: "spacer" }), zoomCtl), pagesHost),
        side),
    )
    status.textContent = `${m.pages.length} page${m.pages.length === 1 ? "" : "s"}`
    await drawPages()
    let lastW = pagesHost.clientWidth
    new ResizeObserver(() => {
      if (Math.abs(pagesHost.clientWidth - lastW) > 40) {
        lastW = pagesHost.clientWidth
        drawPages()
      }
    }).observe(pagesHost)
  }

  if (!id) return uploadStep()
  return editorStep()
}

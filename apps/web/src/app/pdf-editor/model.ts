// The PDF form editor's data and the rules that don't depend on React:
// naming fields, example values, erase areas and colour sampling.
import type { DocumentData, Field, LayoutItem, PageSize, SystemItem, TableLayout, TemplateSettings } from "@doctrust/shared"

export const TYPE_LABELS: Record<string, string> = { text: "Text", textarea: "Long text", number: "Number", date: "Date", select: "Dropdown", checkbox: "Tick box", image: "Image" }
export const COL_TYPES = ["text", "number", "date", "select", "checkbox"] as const
export const IMAGE_SYSTEM_KEYS = ["qr", "org.logo", "preparedBy.signature", "approvedBy.signature"]
export const FAMILIES: Record<string, string> = {
  sans: "Helvetica, Arial, sans-serif",
  serif: "'Times New Roman', Times, serif",
  mono: "'Courier New', Courier, monospace",
}

export interface EditorModel {
  name: string
  description: string
  schema: Field[]
  items: LayoutItem[]
  tables: Record<string, TableLayout>
  pages: PageSize[]
  // sourceHash: the form documents are printed on. originalHash: the PDF as
  // uploaded. They differ when text was erased from the form.
  sourceHash: string | null
  originalHash: string | null
  settings: TemplateSettings & { sampleData: DocumentData }
}

// Something chosen in the side panel, waiting for a click on the page.
export interface Placing {
  kind: LayoutItem["kind"]
  key?: string
  table?: string
  column?: string
  label: string
  w?: number
  h?: number
}

const RESERVED = ["document", "org", "qr", "verifyUrl", "preparedBy", "approvedBy", "isDraft", "data", "pages", "this"]

export function keyFromLabel(label: string, taken: Set<string>): string {
  const words = String(label).normalize("NFKD").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean)
  let key = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("").slice(0, 40)
  if (!/^[a-zA-Z]/.test(key)) key = `field${key}`
  let out = key
  let n = 2
  while (taken.has(out) || RESERVED.includes(out)) out = `${key}${n++}`
  return out
}

// Example values so the preview shows every box filled in.
export function placeholderData(schema: Field[], sample: DocumentData = {}): DocumentData {
  const today = new Date().toISOString().slice(0, 10)
  const val = (f: { type: string; label: string; options?: string[] }) => {
    if (f.type === "number") return 123
    if (f.type === "date") return today
    if (f.type === "select") return (f.options || [])[0] || ""
    if (f.type === "checkbox") return true
    if (f.type === "image") return ""
    return f.label
  }
  const out: DocumentData = {}
  for (const f of schema) {
    const s = sample[f.key]
    if (s !== undefined && s !== "" && !(Array.isArray(s) && !s.length)) out[f.key] = s
    else if (f.type === "table") out[f.key] = [1, 2, 3].map(() => Object.fromEntries((f.columns || []).map((c) => [c.key, val(c)])))
    else out[f.key] = val(f)
  }
  return out
}

export const fieldOf = (m: EditorModel, key?: string) => m.schema.find((f) => f.key === key)

export function itemLabel(m: EditorModel, system: Record<string, SystemItem>, it: LayoutItem): string {
  if (it.kind === "system") return system[it.key!]?.label ?? it.key ?? ""
  if (it.kind === "column") {
    const t = fieldOf(m, it.table)
    const c = it.column === "#" ? { label: "S/N" } : t?.columns?.find((x) => x.key === it.column)
    return `${t ? t.label : it.table} › ${c ? c.label : it.column}`
  }
  const f = fieldOf(m, it.key)
  return f ? f.label : it.key ?? ""
}

const fmtExample = (type: string, val: unknown): string => {
  if (val === undefined || val === null || val === "" || val === false) return ""
  if (type === "checkbox") return "✓"
  if (type === "image") return ""
  if (type === "date") {
    const mm = String(val).match(/^(\d{4})-(\d{2})-(\d{2})/)
    return mm ? `${mm[3]}/${mm[2]}/${mm[1]}` : String(val)
  }
  return String(val)
}

// The example text shown in a box (row: which table row).
export function exampleFor(m: EditorModel, it: LayoutItem, who: { name: string; qualification: string; org: string }, row = 0): string {
  const data = m.settings.sampleData
  if (it.kind === "field") {
    const f = fieldOf(m, it.key)
    return f ? fmtExample(f.type, data[it.key!]) : ""
  }
  if (it.kind === "column") {
    const rows = Array.isArray(data[it.table!]) ? (data[it.table!] as Array<Record<string, unknown>>) : []
    if (!rows[row]) return ""
    if (it.column === "#") return String(row + 1)
    const c = fieldOf(m, it.table)?.columns?.find((x) => x.key === it.column)
    return c ? fmtExample(c.type, rows[row][c.key]) : ""
  }
  const pad = Math.max(1, m.settings.numberPadding || 4)
  const values: Record<string, string> = {
    "document.no": `${m.settings.numberPrefix || ""}${"1".padStart(pad, "0")}`,
    "approvedBy.name": "Awaiting approval",
    "preparedBy.name": who.name,
    "preparedBy.qualification": who.qualification,
    "org.name": who.org,
  }
  return values[it.key!] || ""
}

export const isMultiline = (m: EditorModel, it: LayoutItem) => it.kind === "field" && fieldOf(m, it.key)?.type === "textarea"

// Text boxes (not images, the QR code or tick boxes) can have fonts and colours.
export function isTextItem(m: EditorModel, it: LayoutItem): boolean {
  if (it.kind === "system") return !IMAGE_SYSTEM_KEYS.includes(it.key!)
  if (it.kind === "field") return !["checkbox", "image"].includes(fieldOf(m, it.key)?.type ?? "")
  return true
}

const snap = (n: number) => Math.round(n * 2) / 2
export function clampItem(m: EditorModel, it: LayoutItem) {
  const pg = m.pages[it.page]
  it.w = Math.max(4, Math.min(it.w, pg.width))
  it.h = Math.max(4, Math.min(it.h, pg.height))
  it.x = snap(Math.max(0, Math.min(it.x, pg.width - it.w)))
  it.y = snap(Math.max(0, Math.min(it.y, pg.height - it.h)))
  it.w = snap(it.w)
  it.h = snap(it.h)
}

// Table columns share a first-row line and row height.
export function ensureTable(m: EditorModel, item: LayoutItem) {
  const t = m.tables[item.table!] || (m.tables[item.table!] = {})
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

export function syncTableRow(m: EditorModel, it: LayoutItem, orig: LayoutItem) {
  if (it.y === orig.y && it.h === orig.h) return
  for (const c of m.items) if (c.kind === "column" && c.table === it.table && c.id !== it.id) { c.y = it.y; c.h = it.h }
  const t = m.tables[it.table!]
  if (t && it.h > (t.rowHeight || 0)) t.rowHeight = it.h
}

// The erased area reaches a little past the box, most of all downwards,
// so the tails of old letters (g, j, p, y) below the drawn box go too.
export function eraseRect(m: EditorModel, it: LayoutItem, y = it.y) {
  const pg = m.pages[it.page]
  const x = Math.max(0, it.x - 1.5)
  const top = Math.max(0, y - 1.5)
  return { x, y: top, w: Math.min(pg.width - x, it.w + 3), h: Math.min(pg.height - top, it.h + 3 + it.h * 0.22) }
}

export interface EraseArea {
  page: number
  x: number
  y: number
  w: number
  h: number
  color: string
}

export function eraseAreas(m: EditorModel): EraseArea[] {
  const areas: EraseArea[] = []
  for (const it of m.items) {
    if (!it.erase) continue
    const color = it.eraseColor || "#ffffff"
    if (it.kind === "column") {
      const t = m.tables[it.table!] || {}
      const rh = t.rowHeight || it.h
      const rows = Math.max(1, t.rowsPerPage || 1)
      for (let r = 0; r < rows; r++) {
        const y = it.y + r * rh
        if (y + it.h > m.pages[it.page].height + 0.5) break
        // Table cells: stay inside the row so ruled lines survive.
        areas.push({ page: it.page, x: it.x + 1, y: y + 1, w: it.w - 2, h: it.h - 2, color })
      }
    } else areas.push({ page: it.page, ...eraseRect(m, it), color })
  }
  return areas
}

// Reads the page under a box: the background colour (most common colour) and
// the text colour (most common colour clearly different from it), so a cover
// blends in and new text looks like the text it replaces.
export function sampleColors(m: EditorModel, it: LayoutItem, canvas: HTMLCanvasElement | undefined): { bg: string; ink: string | null } {
  const fallback = { bg: "#ffffff", ink: null }
  try {
    if (!canvas || !canvas.width) return fallback
    const k = canvas.width / m.pages[it.page].width
    const x0 = Math.max(0, Math.floor(it.x * k))
    const y0 = Math.max(0, Math.floor(it.y * k))
    const w = Math.max(1, Math.min(canvas.width - x0, Math.ceil(it.w * k)))
    const hh = Math.max(1, Math.min(canvas.height - y0, Math.ceil(it.h * k)))
    const data = canvas.getContext("2d")!.getImageData(x0, y0, w, hh).data
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
    const step = Math.max(1, Math.floor(Math.sqrt((w * hh) / 6000)))
    for (let yy = 0; yy < hh; yy += step) {
      for (let xx = 0; xx < w; xx += step) {
        const i = (yy * w + xx) * 4
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)
        const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 }
        b.n++
        b.r += data[i]
        b.g += data[i + 1]
        b.b += data[i + 2]
        buckets.set(key, b)
      }
    }
    const avg = (b: { n: number; r: number; g: number; b: number }) => [b.r / b.n, b.g / b.n, b.b / b.n]
    const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`
    const list = [...buckets.values()].sort((a, b) => b.n - a.n)
    const bg = avg(list[0])
    const dist = (a: number[]) => Math.hypot(a[0] - bg[0], a[1] - bg[1], a[2] - bg[2])
    const inkBucket = list.slice(1).find((b) => b.n >= 3 && dist(avg(b)) > 110)
    return { bg: hex(bg), ink: inkBucket ? hex(avg(inkBucket)) : null }
  } catch {
    return fallback
  }
}

// Applies the answer from "What goes in this box?" to a new box (and adds any
// new field, table or column to the schema).
export interface BoxChoice {
  what: string // "new" | "column" | "field:<key>" | "system:<key>"
  label: string
  type: string
  options: string
  required: boolean
  showOnVerify: boolean
  table: string // table key, or "__new"
  tableName: string
  colType: string // column type, or "#" for the row number
  colLabel: string
}

export function applyChoice(m: EditorModel, item: LayoutItem, res: BoxChoice) {
  const taken = new Set(m.schema.map((f) => f.key))
  if (res.what.startsWith("field:")) Object.assign(item, { kind: "field", key: res.what.slice(6) })
  else if (res.what.startsWith("system:")) Object.assign(item, { kind: "system", key: res.what.slice(7) })
  else if (res.what === "column") {
    let tkey = res.table
    if (!tkey || tkey === "__new") {
      const tl = res.tableName.trim() || "Items"
      tkey = keyFromLabel(tl, taken)
      m.schema.push({ key: tkey, label: tl, type: "table", required: true, columns: [] })
    }
    const t = fieldOf(m, tkey)!
    const columns = (t.columns = t.columns || [])
    let ckey = "#"
    if (res.colType !== "#") {
      const cl = res.colLabel.trim() || `Column ${columns.length + 1}`
      ckey = keyFromLabel(cl, new Set(columns.map((c) => c.key)))
      columns.push({ key: ckey, label: cl, type: res.colType as (typeof COL_TYPES)[number], ...(res.colType === "select" ? { options: ["Option 1", "Option 2"] } : {}) })
    }
    Object.assign(item, { kind: "column", table: tkey, column: ckey })
  } else {
    const l = res.label.trim()
    const f: Field = { key: keyFromLabel(l, taken), label: l, type: res.type as Field["type"], required: res.required && res.type !== "checkbox" }
    if (res.showOnVerify && !["image", "checkbox"].includes(res.type)) f.showOnVerify = true
    if (res.type === "select") {
      f.options = res.options.split(",").map((o) => o.trim()).filter(Boolean)
      if (!f.options.length) f.options = ["Option 1", "Option 2"]
    }
    m.schema.push(f)
    Object.assign(item, { kind: "field", key: f.key })
    if (res.type === "textarea" && item.h < 24) item.h = 36
  }
}

// New boxes cover what's printed under them (in the page's colour) and take
// the colour of the text already there.
export function applyEraseDefaults(m: EditorModel, item: LayoutItem, canvas: HTMLCanvasElement | undefined) {
  const { bg, ink } = sampleColors(m, item, canvas)
  item.erase = true
  item.eraseColor = bg
  if (isTextItem(m, item) && ink) item.color = ink
}

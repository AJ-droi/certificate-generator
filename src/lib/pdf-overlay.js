// PDF templates: the company's own PDF is the design. The layout says where each
// piece of data goes (boxes in points, measured from the top-left of the page as
// it is displayed). Issuing prints the data onto copies of the original pages.
const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = require("pdf-lib")
const QRCode = require("qrcode")
const { badRequest } = require("./errors")

const MAX_SOURCE_BYTES = 15 * 1024 * 1024
const MAX_PAGES = 30
const MAX_ITEMS = 600

// Things the system fills in, which admins can place on the page.
const SYSTEM_ITEMS = {
  qr: { label: "QR code", type: "qr" },
  "document.no": { label: "Document number", type: "text" },
  "document.verificationCode": { label: "Verification code", type: "text" },
  "document.issuedAt": { label: "Issue date", type: "date" },
  "org.name": { label: "Company name", type: "text" },
  "org.logo": { label: "Company logo", type: "image" },
  "preparedBy.name": { label: "Prepared by — name", type: "text" },
  "preparedBy.qualification": { label: "Prepared by — qualification", type: "text" },
  "preparedBy.signature": { label: "Prepared by — signature", type: "image" },
  "preparedBy.date": { label: "Prepared by — date", type: "date" },
  "approvedBy.name": { label: "Approved by — name", type: "text" },
  "approvedBy.qualification": { label: "Approved by — qualification", type: "text" },
  "approvedBy.signature": { label: "Approved by — signature", type: "image" },
  "approvedBy.date": { label: "Approved by — date", type: "date" },
}

// ---- Page geometry --------------------------------------------------------------
// Pages can have a crop box offset and a /Rotate flag. Layout coordinates are in
// the displayed (rotated) page, top-left origin, like what the editor shows.

function geometry(page) {
  const box = page.getCropBox()
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  const swap = rotation === 90 || rotation === 270
  return {
    bx: box.x, by: box.y, W: box.width, H: box.height, rotation,
    width: swap ? box.height : box.width,
    height: swap ? box.width : box.height,
  }
}

// Displayed (X, Y from top-left) -> PDF user space (x, y from bottom-left).
function toUser(g, X, Y) {
  switch (g.rotation) {
    case 90: return { x: g.bx + Y, y: g.by + X }
    case 180: return { x: g.bx + g.W - X, y: g.by + Y }
    case 270: return { x: g.bx + g.W - Y, y: g.by + g.H - X }
    default: return { x: g.bx + X, y: g.by + g.H - Y }
  }
}

function fromUser(g, x, y) {
  switch (g.rotation) {
    case 90: return { X: y - g.by, Y: x - g.bx }
    case 180: return { X: g.bx + g.W - x, Y: y - g.by }
    case 270: return { X: g.by + g.H - y, Y: g.bx + g.W - x }
    default: return { X: x - g.bx, Y: g.by + g.H - y }
  }
}

const round = (n) => Math.round(n * 100) / 100

// ---- Upload validation ------------------------------------------------------------

async function loadPdf(buffer) {
  try {
    return await PDFDocument.load(buffer, { updateMetadata: false })
  } catch (err) {
    if (/encrypt/i.test(err.message)) {
      throw badRequest("This PDF is password-protected or encrypted. Remove the protection and upload it again.")
    }
    throw badRequest("This file couldn't be read as a PDF. Try re-saving it (Print → Save as PDF) and upload again.")
  }
}

const prettify = (name) =>
  String(name)
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .slice(0, 120) || "Field"

// Checks an uploaded PDF and reports its pages and any fillable form fields,
// which the editor offers to turn into fields automatically.
async function inspectSourcePdf(buffer) {
  if (!buffer || buffer.length < 100) throw badRequest("The file is empty")
  if (buffer.length > MAX_SOURCE_BYTES) throw badRequest("PDF is too large (max 15 MB)")
  if (buffer.subarray(0, 1024).toString("latin1").indexOf("%PDF-") === -1) throw badRequest("That file isn't a PDF")
  const doc = await loadPdf(buffer)
  const pages = doc.getPages()
  if (pages.length === 0) throw badRequest("The PDF has no pages")
  if (pages.length > MAX_PAGES) throw badRequest(`The PDF has ${pages.length} pages (max ${MAX_PAGES})`)
  const geos = pages.map(geometry)

  const formFields = []
  let form
  try {
    form = doc.getForm()
  } catch {
    form = null
  }
  if (form) {
    const pageRefs = pages.map((p) => p.ref)
    for (const field of form.getFields().slice(0, 300)) {
      let type = null
      let options
      if (field instanceof PDFTextField) type = field.isMultiline() ? "textarea" : "text"
      else if (field instanceof PDFCheckBox) type = "checkbox"
      else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        type = "select"
        options = field.getOptions().map(String).filter(Boolean).slice(0, 100)
      } else if (field instanceof PDFRadioGroup) {
        type = "select"
        options = field.getOptions().map(String).filter(Boolean).slice(0, 100)
      }
      if (!type) continue
      if (type === "select" && (!options || !options.length)) type = "text"
      const widgets = field.acroField.getWidgets()
      const widget = widgets[0]
      if (!widget) continue
      const rect = widget.getRectangle()
      let pageIndex = pageRefs.findIndex((ref) => ref === widget.P())
      if (pageIndex === -1) {
        pageIndex = pages.findIndex((p) => {
          const annots = p.node.Annots()
          return annots && annots.asArray().some((a) => a === widget.dict || doc.context.lookup(a) === widget.dict)
        })
      }
      if (pageIndex === -1) continue
      const g = geos[pageIndex]
      const a = fromUser(g, rect.x, rect.y)
      const b = fromUser(g, rect.x + rect.width, rect.y + rect.height)
      formFields.push({
        name: field.getName(),
        label: prettify(field.getName().split(".").pop()),
        type,
        options,
        page: pageIndex,
        x: round(Math.min(a.X, b.X)),
        y: round(Math.min(a.Y, b.Y)),
        w: round(Math.abs(b.X - a.X)),
        h: round(Math.abs(b.Y - a.Y)),
      })
    }
  }

  return {
    pageCount: pages.length,
    pages: geos.map((g) => ({ width: round(g.width), height: round(g.height) })),
    formFields,
  }
}

// ---- Layout validation -------------------------------------------------------------

const num = (v) => typeof v === "number" && Number.isFinite(v)

function validateLayout(layout, schema, pages) {
  if (!layout || typeof layout !== "object") throw badRequest("Page layout is missing")
  const items = Array.isArray(layout.items) ? layout.items : []
  if (items.length > MAX_ITEMS) throw badRequest(`Too many boxes on the pages (max ${MAX_ITEMS})`)
  const fields = new Map(schema.map((f) => [f.key, f]))
  const errors = []
  const seenIds = new Set()

  const cleanItems = items.map((raw, i) => {
    const where = `Box ${i + 1}`
    const item = {
      id: String(raw.id || `i${i + 1}`).slice(0, 40),
      kind: raw.kind,
      page: Number(raw.page),
      x: Number(raw.x), y: Number(raw.y), w: Number(raw.w), h: Number(raw.h),
    }
    if (seenIds.has(item.id)) item.id = `${item.id}-${i}`
    seenIds.add(item.id)
    if (!Number.isInteger(item.page) || item.page < 0 || item.page >= pages.length) {
      errors.push(`${where} is on a page that doesn't exist`)
      return null
    }
    const pg = pages[item.page]
    if (![item.x, item.y, item.w, item.h].every(num) || item.w < 2 || item.h < 2) {
      errors.push(`${where} has an invalid size`)
      return null
    }
    // Keep boxes on the page.
    item.x = round(Math.max(0, Math.min(item.x, pg.width - 2)))
    item.y = round(Math.max(0, Math.min(item.y, pg.height - 2)))
    item.w = round(Math.min(item.w, pg.width - item.x))
    item.h = round(Math.min(item.h, pg.height - item.y))
    if (raw.fontSize !== undefined && raw.fontSize !== null && raw.fontSize !== "") {
      const fs = Number(raw.fontSize)
      if (num(fs) && fs >= 4 && fs <= 72) item.fontSize = fs
    }
    if (["left", "center", "right"].includes(raw.align)) item.align = raw.align
    if (["sans", "serif", "mono"].includes(raw.font) && raw.font !== "sans") item.font = raw.font
    if (raw.bold === true) item.bold = true
    if (/^#[0-9a-f]{6}$/i.test(String(raw.color || ""))) item.color = raw.color.toLowerCase()
    // "Erase what's printed underneath": applied by the editor, which uploads a
    // cleaned copy of the form. Kept here so the editor can redo it later.
    if (raw.erase === true) {
      item.erase = true
      if (/^#[0-9a-f]{6}$/i.test(String(raw.eraseColor || ""))) item.eraseColor = raw.eraseColor.toLowerCase()
    }

    if (item.kind === "field") {
      const f = fields.get(raw.key)
      if (!f || f.type === "table") {
        errors.push(`${where} points to a field that doesn't exist ("${raw.key}")`)
        return null
      }
      item.key = f.key
    } else if (item.kind === "system") {
      if (!SYSTEM_ITEMS[raw.key]) {
        errors.push(`${where} has an unknown item "${raw.key}"`)
        return null
      }
      item.key = raw.key
    } else if (item.kind === "column") {
      const t = fields.get(raw.table)
      // "#" is the automatic row number (S/N).
      const col = t && t.type === "table" && (raw.column === "#" ? { key: "#" } : t.columns.find((c) => c.key === raw.column))
      if (!col) {
        errors.push(`${where} points to a table column that doesn't exist`)
        return null
      }
      item.table = t.key
      item.column = col.key
    } else {
      errors.push(`${where} has an unknown type`)
      return null
    }
    return item
  }).filter(Boolean)

  // Table settings: which page the rows start on, row spacing, rows per page.
  const tables = {}
  for (const t of schema.filter((f) => f.type === "table")) {
    const cols = cleanItems.filter((i) => i.kind === "column" && i.table === t.key)
    if (!cols.length) continue
    const pagesUsed = new Set(cols.map((c) => c.page))
    if (pagesUsed.size > 1) errors.push(`All columns of "${t.label}" must be on the same page`)
    const cfg = (layout.tables && layout.tables[t.key]) || {}
    const rowHeight = num(Number(cfg.rowHeight)) && Number(cfg.rowHeight) >= 4 ? Number(cfg.rowHeight) : Math.max(...cols.map((c) => c.h))
    const firstY = Math.min(...cols.map((c) => c.y))
    const pageH = pages[cols[0].page].height
    const maxFit = Math.max(1, Math.floor((pageH - firstY) / rowHeight))
    let rowsPerPage = Math.floor(Number(cfg.rowsPerPage))
    if (!Number.isFinite(rowsPerPage) || rowsPerPage < 1) rowsPerPage = maxFit
    tables[t.key] = { page: cols[0].page, rowHeight: round(rowHeight), rowsPerPage: Math.min(rowsPerPage, maxFit, 200) }
  }

  if (errors.length) throw badRequest("The page layout needs attention", { errors: errors.slice(0, 30) })
  return { items: cleanItems, tables }
}

// Fields in the schema that aren't placed anywhere (shown as a warning in the editor).
function unplacedFields(schema, layout) {
  const placed = new Set()
  for (const i of layout.items) placed.add(i.kind === "column" ? i.table : i.key)
  return schema.filter((f) => !placed.has(f.key)).map((f) => f.label)
}

// ---- Rendering --------------------------------------------------------------------------

function sanitizeText(font, text) {
  const supported = new Set(font.getCharacterSet())
  let out = ""
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    if (ch === "\n" || supported.has(cp)) out += ch
    else if (/[‘’]/.test(ch)) out += "'"
    else if (/[“”]/.test(ch)) out += '"'
    else if (/[–—]/.test(ch)) out += "-"
    else if (ch === "₦") out += "N" // Naira sign isn't in the standard PDF fonts
    else if (/\s/.test(ch)) out += " "
    else out += "?"
  }
  return out
}

function wrapLines(font, text, size, width) {
  const lines = []
  for (const para of String(text).split("\n")) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      lines.push("")
      continue
    }
    let line = ""
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

function drawTextBox(page, g, font, box, text, { multiline = false, fontSize, align = "left", color = rgb(0.05, 0.05, 0.12) } = {}) {
  const value = sanitizeText(font, text).trim()
  if (!value) return
  const pad = Math.min(2, box.w * 0.05)
  const innerW = Math.max(1, box.w - pad * 2)
  // Auto size: fill the box height (like the text it replaces), then shrink to fit the width.
  let size = fontSize || (multiline ? Math.min(12, Math.max(5, box.h * 0.72)) : Math.max(5, box.h * 0.72))
  let lines

  if (multiline) {
    for (;;) {
      lines = wrapLines(font, value, size, innerW)
      const fits = lines.length * size * 1.15 <= box.h + 0.5 && lines.every((l) => font.widthOfTextAtSize(l, size) <= innerW + 0.5)
      if (fits || size <= 4) break
      size = Math.max(4, size - 0.5)
    }
  } else {
    const single = value.replace(/\s*\n\s*/g, ", ")
    size = Math.min(size, box.h * 0.85)
    while (font.widthOfTextAtSize(single, size) > innerW && size > 4) size -= 0.25
    lines = [single]
  }

  const lineH = size * 1.15
  const blockH = lines.length * lineH
  // Single lines sit in the vertical middle; wrapped text starts at the top.
  let top = multiline ? box.y + Math.min(pad, Math.max(0, box.h - blockH)) : box.y + (box.h - lineH) / 2
  for (const line of lines) {
    const w = font.widthOfTextAtSize(line, size)
    let X = box.x + pad
    if (align === "center") X = box.x + (box.w - w) / 2
    else if (align === "right") X = box.x + box.w - pad - w
    const baseline = top + size * 0.93
    const p = toUser(g, X, baseline)
    page.drawText(line, { x: p.x, y: p.y, size, font, color, rotate: degrees(g.rotation) })
    top += lineH
  }
}

function drawCheck(page, g, box) {
  const s = Math.min(box.w, box.h) * 0.8
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const pts = [
    [cx - s * 0.4, cy],
    [cx - s * 0.1, cy + s * 0.32],
    [cx + s * 0.42, cy - s * 0.35],
  ].map(([X, Y]) => toUser(g, X, Y))
  const thickness = Math.max(0.8, s * 0.12)
  const color = rgb(0.05, 0.05, 0.12)
  page.drawLine({ start: pts[0], end: pts[1], thickness, color })
  page.drawLine({ start: pts[1], end: pts[2], thickness, color })
}

async function drawImageBox(page, g, image, box) {
  const scale = Math.min(box.w / image.width, box.h / image.height)
  const w = image.width * scale
  const h = image.height * scale
  const X = box.x + (box.w - w) / 2
  const Y = box.y + (box.h - h) / 2
  const anchor = toUser(g, X, Y + h) // bottom-left of the image as displayed
  page.drawImage(image, { x: anchor.x, y: anchor.y, width: w, height: h, rotate: degrees(g.rotation) })
}

function drawStamp(page, g, font, label) {
  const size = Math.min(g.width, g.height) / (label.length * 0.62)
  const textW = font.widthOfTextAtSize(label, size)
  const angle = Math.atan2(g.height, g.width)
  // Centre a diagonal line of text on the displayed page.
  const cx = g.width / 2 - (Math.cos(angle) * textW) / 2 + (Math.sin(angle) * size * 0.35)
  const cy = g.height / 2 + (Math.sin(angle) * textW) / 2 + (Math.cos(angle) * size * 0.35)
  const p = toUser(g, cx, cy)
  page.drawText(label, {
    x: p.x, y: p.y, size, font,
    color: rgb(0.78, 0.1, 0.1),
    opacity: 0.22,
    rotate: degrees(g.rotation + (angle * 180) / Math.PI),
  })
}

function formatDateValue(v) {
  if (!v) return ""
  const s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`
  return s
}

function valueFor(field, v) {
  if (v === undefined || v === null) return ""
  if (field && field.type === "date") return formatDateValue(v)
  if (field && field.type === "number") return String(v)
  return String(v)
}

function systemValue(key, ctx) {
  const [group, prop] = key.split(".")
  if (key === "qr") return ctx.qr
  if (group === "document") return ctx.document[prop]
  if (group === "org") return ctx.org[prop]
  const person = ctx[group]
  if (!person) return ""
  if (prop === "date") return person.date
  return person[prop]
}

/**
 * Prints data onto the source PDF.
 * @param {object} p
 * @param {Buffer} p.source       original PDF bytes
 * @param {object} p.layout       validated layout
 * @param {Array}  p.schema
 * @param {object} p.context      same context HTML templates get (data, document, org, qr, preparedBy, approvedBy, isDraft)
 * @param {string} [p.stamp]      diagonal label, e.g. "DRAFT · NOT VALID"
 * @param {function} p.toPng      converts any image data URL to PNG bytes (for WebP/GIF/SVG)
 */
async function renderOverlay({ source, layout, schema, context, stamp, toPng }) {
  const src = await loadPdf(source)
  try {
    src.getForm().flatten()
  } catch {
    // Some forms can't be flattened; their widgets are removed below instead.
  }
  const out = await PDFDocument.create()
  const stampFont = await out.embedFont(StandardFonts.HelveticaBold)
  const FONTS = {
    sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
    serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
    mono: [StandardFonts.Courier, StandardFonts.CourierBold],
  }
  const fontCache = new Map()
  async function fontFor(item) {
    const name = FONTS[item.font || "sans"][item.bold ? 1 : 0]
    if (!fontCache.has(name)) fontCache.set(name, await out.embedFont(name))
    return fontCache.get(name)
  }
  const hexColor = (hex) => {
    const n = parseInt(hex.slice(1), 16)
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
  }
  const fields = new Map(schema.map((f) => [f.key, f]))
  const imageCache = new Map()

  async function image(dataUrl) {
    if (!dataUrl) return null
    if (imageCache.has(dataUrl)) return imageCache.get(dataUrl)
    let img = null
    try {
      const m = String(dataUrl).match(/^data:image\/([a-z+]+);base64,(.+)$/)
      if (m) {
        const bytes = Buffer.from(m[2], "base64")
        if (m[1] === "png") img = await out.embedPng(bytes)
        else if (m[1] === "jpeg" || m[1] === "jpg") img = await out.embedJpg(bytes)
        else if (toPng) img = await out.embedPng(await toPng(dataUrl))
      }
    } catch {
      img = null
    }
    imageCache.set(dataUrl, img)
    return img
  }

  // How many copies of each page: tables that overflow repeat their page.
  const srcPages = src.getPageCount()
  const copies = new Array(srcPages).fill(1)
  const tableChunks = {}
  for (const [key, t] of Object.entries(layout.tables || {})) {
    const rows = Array.isArray(context.data[key]) ? context.data[key] : []
    const n = Math.max(1, Math.ceil(rows.length / t.rowsPerPage))
    tableChunks[key] = n
    copies[t.page] = Math.max(copies[t.page], n)
  }
  const order = []
  copies.forEach((n, i) => {
    for (let k = 0; k < n; k++) order.push({ index: i, copy: k })
  })
  // Copy each output page in its own call: copying one source page twice in a single
  // call returns the same object, so both copies would get the same content.
  const pages = []
  for (const o of order) pages.push((await out.copyPages(src, [o.index]))[0])

  let qrImage = null
  if (context.qr) qrImage = await out.embedPng(Buffer.from(context.qr.split(",")[1], "base64"))

  for (let n = 0; n < pages.length; n++) {
    const page = out.addPage(pages[n])
    // Drop annotations (form widgets, links, scripts) from the copy.
    page.node.delete(PDFName.of("Annots"))
    const g = geometry(page)
    const { index, copy } = order[n]
    const items = layout.items.filter((i) => i.page === index)

    for (const item of items) {
      const box = { x: item.x, y: item.y, w: item.w, h: item.h }
      const opts = { fontSize: item.fontSize, align: item.align, ...(item.color ? { color: hexColor(item.color) } : {}) }
      const itemFont = await fontFor(item)
      if (item.kind === "field") {
        const f = fields.get(item.key)
        const v = context.data[item.key]
        if (f.type === "checkbox") {
          if (v) drawCheck(page, g, box)
        } else if (f.type === "image") {
          const img = await image(v)
          if (img) await drawImageBox(page, g, img, box)
        } else {
          drawTextBox(page, g, itemFont, box, valueFor(f, v), { ...opts, multiline: f.type === "textarea" })
        }
      } else if (item.kind === "system") {
        const def = SYSTEM_ITEMS[item.key]
        if (def.type === "qr") {
          if (qrImage) await drawImageBox(page, g, qrImage, box)
        } else if (def.type === "image") {
          const img = await image(systemValue(item.key, context))
          if (img) await drawImageBox(page, g, img, box)
        } else if (item.key === "approvedBy.name" && !context.approvedBy) {
          // Not approved yet: say so where the approver's name will go.
          drawTextBox(page, g, itemFont, box, "Awaiting approval", { ...opts, color: rgb(0.45, 0.47, 0.5) })
        } else {
          const raw = systemValue(item.key, context)
          drawTextBox(page, g, itemFont, box, def.type === "date" ? formatDateValue(raw) : raw || "", opts)
        }
      } else if (item.kind === "column") {
        const t = layout.tables[item.table]
        const col = item.column === "#" ? { key: "#", type: "number" } : fields.get(item.table).columns.find((c) => c.key === item.column)
        const rows = Array.isArray(context.data[item.table]) ? context.data[item.table] : []
        if (copy >= tableChunks[item.table]) continue
        const chunk = rows.slice(copy * t.rowsPerPage, (copy + 1) * t.rowsPerPage)
        chunk.forEach((row, r) => {
          const rowBox = { ...box, y: box.y + r * t.rowHeight }
          if (col.key === "#") {
            drawTextBox(page, g, itemFont, rowBox, String(copy * t.rowsPerPage + r + 1), opts)
          } else if (col.type === "checkbox") {
            if (row[col.key]) drawCheck(page, g, rowBox)
          } else {
            drawTextBox(page, g, itemFont, rowBox, valueFor(col, row[col.key]), opts)
          }
        })
      }
    }
    if (stamp) drawStamp(page, g, stampFont, stamp)
  }

  out.setTitle(String(context.document.no || "Document"))
  out.setProducer("DocTrust")
  out.setCreator(String(context.org.name || ""))
  return Buffer.from(await out.save({ useObjectStreams: true }))
}

async function qrPng(url) {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 400 })
}

module.exports = {
  SYSTEM_ITEMS,
  inspectSourcePdf,
  validateLayout,
  unplacedFields,
  renderOverlay,
  qrPng,
  MAX_SOURCE_BYTES,
  // exported for tests
  _geometry: { geometry, toUser, fromUser },
}

// A template's field schema: the list of fields a document of that type has.
// The dashboard builds its form from this, and document data is validated against it.
//
// [
//   { "key": "employerName", "label": "Employer", "type": "text", "required": true },
//   { "key": "reason", "label": "Reason", "type": "select", "options": ["A", "B"] },
//   { "key": "items", "label": "Items", "type": "table", "columns": [
//       { "key": "description", "label": "Description", "type": "text" } ] }
// ]
const { badRequest } = require("./errors")

const SCALAR_TYPES = ["text", "textarea", "number", "date", "select", "checkbox", "image"]
const COLUMN_TYPES = ["text", "number", "date", "select", "checkbox"]
const RESERVED = new Set([
  "document", "org", "qr", "verifyUrl", "preparedBy", "approvedBy", "isDraft", "data", "pages", "this",
])
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/
const MAX_IMAGE_CHARS = 700_000 // ~500 KB image
const MAX_TEXT = 5000
const MAX_ROWS = 2000

function cleanField(field, where, allowed) {
  if (!field || typeof field !== "object") throw badRequest(`${where}: must be an object`)
  const key = String(field.key || "").trim()
  if (!KEY_RE.test(key)) {
    throw badRequest(`${where}: key "${key}" must start with a letter and use only letters, numbers and _`)
  }
  if (RESERVED.has(key)) throw badRequest(`${where}: "${key}" is a reserved name`)
  const type = field.type || "text"
  if (!allowed.includes(type)) throw badRequest(`${where}: unknown type "${type}"`)
  const out = {
    key,
    label: String(field.label || key).slice(0, 200),
    type,
    required: Boolean(field.required),
  }
  if (field.help) out.help = String(field.help).slice(0, 500)
  if (field.showOnVerify) out.showOnVerify = true
  if (type === "select") {
    if (!Array.isArray(field.options) || field.options.length === 0) {
      throw badRequest(`${where}: a select field needs a list of options`)
    }
    out.options = field.options.map((o) => String(o).slice(0, 200))
  }
  if (field.default !== undefined) out.default = field.default
  return out
}

function validateSchema(schema) {
  if (!Array.isArray(schema)) throw badRequest("Field schema must be a JSON array")
  if (schema.length > 200) throw badRequest("Too many fields (max 200)")
  const seen = new Set()
  return schema.map((field, i) => {
    const where = `Field ${i + 1}`
    const isTable = field && field.type === "table"
    const out = cleanField(field, where, isTable ? ["table"] : SCALAR_TYPES)
    if (seen.has(out.key)) throw badRequest(`${where}: duplicate key "${out.key}"`)
    seen.add(out.key)
    if (isTable) {
      if (!Array.isArray(field.columns) || field.columns.length === 0) {
        throw badRequest(`${where}: a table needs columns`)
      }
      const colKeys = new Set()
      out.columns = field.columns.map((c, j) => {
        const col = cleanField(c, `${where}, column ${j + 1}`, COLUMN_TYPES)
        if (colKeys.has(col.key)) throw badRequest(`${where}: duplicate column "${col.key}"`)
        colKeys.add(col.key)
        return col
      })
    }
    return out
  })
}

function coerce(field, value, where, errors) {
  const empty = value === undefined || value === null || value === ""
  switch (field.type) {
    case "checkbox":
      return value === true || value === "true" || value === "on" || value === 1 || value === "1" || value === "yes"
    case "number": {
      if (empty) return null
      const n = Number(value)
      if (!Number.isFinite(n)) errors.push(`${where} must be a number`)
      return Number.isFinite(n) ? n : null
    }
    case "select": {
      if (empty) return ""
      const v = String(value)
      if (!field.options.includes(v)) errors.push(`${where} must be one of: ${field.options.join(", ")}`)
      return v
    }
    case "image": {
      if (empty) return ""
      const v = String(value)
      if (!IMAGE_RE.test(v)) errors.push(`${where} must be a PNG, JPEG, WebP or GIF image`)
      else if (v.length > MAX_IMAGE_CHARS) errors.push(`${where} image is too large (max ~500 KB)`)
      return v
    }
    default: {
      if (empty) return ""
      const v = String(value)
      if (v.length > MAX_TEXT) errors.push(`${where} is too long`)
      return v.slice(0, MAX_TEXT)
    }
  }
}

const isBlank = (field, v) =>
  field.type === "checkbox" ? false : v === "" || v === null || v === undefined

// Returns clean data containing only schema fields. With {strict:true}, required
// fields must be filled (used when submitting/issuing; drafts can be incomplete).
function normalizeData(schema, input, { strict = false } = {}) {
  const src = input && typeof input === "object" ? input : {}
  const errors = []
  const out = {}
  for (const field of schema) {
    if (field.type === "table") {
      const rows = Array.isArray(src[field.key]) ? src[field.key] : []
      if (rows.length > MAX_ROWS) errors.push(`${field.label} has too many rows (max ${MAX_ROWS})`)
      out[field.key] = rows.slice(0, MAX_ROWS).map((row, r) => {
        const clean = {}
        for (const col of field.columns) {
          const where = `${field.label} row ${r + 1}, ${col.label}`
          clean[col.key] = coerce(col, row && row[col.key], where, errors)
          if (strict && col.required && isBlank(col, clean[col.key])) errors.push(`${where} is required`)
        }
        return clean
      })
      if (strict && field.required && out[field.key].length === 0) errors.push(`${field.label} needs at least one row`)
    } else {
      const raw = src[field.key] === undefined ? field.default : src[field.key]
      out[field.key] = coerce(field, raw, field.label, errors)
      if (strict && field.required && isBlank(field, out[field.key])) errors.push(`${field.label} is required`)
    }
  }
  if (errors.length) throw badRequest("Some fields need attention", { errors: errors.slice(0, 50) })
  return out
}

// Fields to show on the public verify page: those flagged showOnVerify, or the
// first few simple fields if none are flagged.
function verifyFields(schema, data) {
  const simple = schema.filter((f) => !["table", "image"].includes(f.type))
  const flagged = simple.filter((f) => f.showOnVerify)
  const picked = flagged.length ? flagged : simple.slice(0, 6)
  const show = (f, v) => {
    if (f.type === "checkbox") return v ? "Yes" : "No"
    if (f.type === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      return new Date(`${v}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    }
    return String(v ?? "")
  }
  const rows = picked.map((f) => ({ label: f.label, value: show(f, data[f.key]) }))
  for (const t of schema.filter((f) => f.type === "table")) {
    rows.push({ label: t.label, value: `${(data[t.key] || []).length} row(s)` })
  }
  return rows
}

module.exports = { validateSchema, normalizeData, verifyFields, SCALAR_TYPES, COLUMN_TYPES }

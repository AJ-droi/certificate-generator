const Handlebars = require("handlebars")
const QRCode = require("qrcode")
const { formatPublicId } = require("./crypto")
const { badRequest } = require("./errors")

// One isolated Handlebars instance with a small set of helpers template authors can use.
const hb = Handlebars.create()

hb.registerHelper("chunk", (items, size) => {
  const list = Array.isArray(items) ? items : []
  const n = Math.max(1, Number(size) || 10)
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out.length ? out : [[]]
})
hb.registerHelper("eq", (a, b) => a === b)
hb.registerHelper("ne", (a, b) => a !== b)
hb.registerHelper("and", (...args) => args.slice(0, -1).every(Boolean))
hb.registerHelper("or", (...args) => args.slice(0, -1).some(Boolean))
hb.registerHelper("not", (a) => !a)
hb.registerHelper("inc", (n) => Number(n) + 1)
hb.registerHelper("add", (a, b) => Number(a) + Number(b))
hb.registerHelper("mul", (a, b) => Number(a) * Number(b))
hb.registerHelper("length", (v) => (Array.isArray(v) ? v.length : 0))
hb.registerHelper("check", (v) => (v ? "✓" : ""))
hb.registerHelper("yesno", (v) => (v ? "Yes" : "No"))
hb.registerHelper("default", (v, fallback) => (v === undefined || v === null || v === "" ? fallback : v))
hb.registerHelper("upper", (v) => String(v ?? "").toUpperCase())
hb.registerHelper("formatDate", (v) => {
  if (!v) return ""
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" })
})

const cache = new Map()
function compile(cacheKey, html) {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)
  const fn = hb.compile(html, { preventIndent: true })
  if (cacheKey) {
    if (cache.size > 500) cache.clear()
    cache.set(cacheKey, fn)
  }
  return fn
}

// Throws a readable error if the template has syntax errors.
function checkTemplateSyntax(html) {
  try {
    hb.precompile(html)
  } catch (err) {
    throw badRequest(`Template error: ${err.message.replace(/\s+/g, " ").slice(0, 300)}`)
  }
}

function personView(user, date) {
  if (!user) return null
  return {
    name: user.name,
    qualification: user.qualification || "",
    signature: user.signature || "",
    date: date ? new Date(date).toISOString() : "",
  }
}

const DRAFT_OVERLAY = `
<style>
.__draft-mark{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2147483647}
.__draft-mark span{transform:rotate(-30deg);font:700 64px/1 Arial,sans-serif;color:rgba(200,0,0,.18);border:6px solid rgba(200,0,0,.18);padding:12px 32px;letter-spacing:4px}
</style>
<div class="__draft-mark"><span>DRAFT · NOT VALID</span></div>`

async function qrDataUrl(url) {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 300 })
}

/**
 * Renders a document to HTML.
 * @param {object} p
 * @param {object} p.version   TemplateVersion (html, id)
 * @param {object} p.data      document field values
 * @param {object} p.org       Organization
 * @param {object} p.document  { documentNo, status, publicId, issuedAt }
 * @param {object} p.preparedBy / p.approvedBy  users
 * @param {string} p.baseUrl
 */
async function buildContext(p) {
  const doc = p.document || {}
  const isDraft = doc.status !== "issued" || !doc.publicId
  const verifyUrl = doc.publicId ? `${p.baseUrl}/v/${doc.publicId}` : ""
  const context = {
    ...p.data,
    data: p.data,
    document: {
      no: doc.documentNo || "DRAFT",
      status: doc.status || "draft",
      issuedAt: doc.issuedAt ? new Date(doc.issuedAt).toISOString() : "",
      verificationCode: doc.publicId ? formatPublicId(doc.publicId) : "",
    },
    org: { name: p.org.name, logo: p.org.logo || "" },
    qr: verifyUrl ? await qrDataUrl(verifyUrl) : "",
    verifyUrl,
    preparedBy: personView(p.preparedBy, doc.createdAt),
    approvedBy: isDraft ? null : personView(p.approvedBy, doc.issuedAt),
    isDraft,
  }
  return context
}

async function renderDocument(p) {
  const context = await buildContext(p)
  const isDraft = context.isDraft
  let html = compile(p.version.id, p.version.html)(context)
  if (isDraft && p.watermark !== false) {
    html = html.includes("</body>") ? html.replace("</body>", `${DRAFT_OVERLAY}</body>`) : html + DRAFT_OVERLAY
  }
  return html
}

module.exports = { renderDocument, buildContext, checkTemplateSyntax, qrDataUrl }

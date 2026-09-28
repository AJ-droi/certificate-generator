const crypto = require("crypto")

// Short-lived store for rendered previews. The dashboard shows them in an iframe
// pointing at /render/:token, served with a sandbox CSP so customer template
// code can never run with the dashboard's origin or cookies.
// (In-memory: fine for one server. Use Redis or similar if you run several.)
const TTL_MS = 10 * 60 * 1000
const MAX = 300
const store = new Map()

// `out` is { kind: "html" | "pdf", body }.
function put(out) {
  const now = Date.now()
  for (const [k, v] of store) if (v.expires < now) store.delete(k)
  while (store.size >= MAX) store.delete(store.keys().next().value)
  const token = crypto.randomBytes(24).toString("base64url")
  store.set(token, { out, expires: now + TTL_MS })
  return token
}

function get(token) {
  const item = store.get(String(token))
  if (!item || item.expires < Date.now()) return null
  return item.out
}

function sandboxCsp() {
  const hosts = String(process.env.RENDER_ALLOWED_HOSTS ?? "cdn.tailwindcss.com,fonts.googleapis.com,fonts.gstatic.com,cdn.jsdelivr.net,cdnjs.cloudflare.com")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => `https://${h}`)
    .join(" ")
  return [
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${hosts}`,
    `style-src 'unsafe-inline' ${hosts}`,
    `img-src data: ${hosts}`,
    `font-src data: ${hosts}`,
    `connect-src ${hosts}`,
  ].join("; ")
}

function sendPdf(res, pdf, filename = "preview.pdf") {
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/[^A-Za-z0-9._-]+/g, "_")}"`)
  res.setHeader("Cache-Control", "no-store")
  res.send(pdf)
}

// Sends a render result: PDFs as-is, HTML inside a sandbox.
function send(res, out, filename) {
  if (out.kind === "pdf") return sendPdf(res, out.body, filename)
  return sendSandboxed(res, out.body)
}

function sendSandboxed(res, html) {
  res.setHeader("Content-Security-Policy", sandboxCsp())
  res.setHeader("Content-Type", "text/html; charset=utf-8")
  res.setHeader("Cache-Control", "no-store")
  res.send(html)
}

module.exports = { put, get, send, sendSandboxed, sendPdf }

const crypto = require("crypto")
const { config } = require("../config")
const { getRedis } = require("./redis")

// Short-lived store for rendered previews. The dashboard shows them in an iframe
// pointing at /render/:token, served with a sandbox CSP so customer template
// code can never run with the dashboard's origin or cookies.
// Kept in Redis when configured (any server can serve the preview), otherwise
// in this process's memory.
const TTL_MS = 10 * 60 * 1000
const MAX = 300
const memory = new Map()
const redisKey = (token) => `preview:${token}`

// `out` is { kind: "html" | "pdf", body }. Returns the token.
async function put(out) {
  const token = crypto.randomBytes(24).toString("base64url")
  const redis = getRedis()
  if (redis) {
    const body = Buffer.isBuffer(out.body) ? out.body.toString("base64") : out.body
    await redis.set(redisKey(token), JSON.stringify({ kind: out.kind, body, binary: Buffer.isBuffer(out.body) }), { PX: TTL_MS })
    return token
  }
  const now = Date.now()
  for (const [k, v] of memory) if (v.expires < now) memory.delete(k)
  while (memory.size >= MAX) memory.delete(memory.keys().next().value)
  memory.set(token, { out, expires: now + TTL_MS })
  return token
}

async function get(token) {
  const t = String(token)
  if (!/^[A-Za-z0-9_-]{32}$/.test(t)) return null
  const redis = getRedis()
  if (redis) {
    const raw = await redis.get(redisKey(t))
    if (!raw) return null
    const v = JSON.parse(raw)
    return { kind: v.kind, body: v.binary ? Buffer.from(v.body, "base64") : v.body }
  }
  const item = memory.get(t)
  if (!item || item.expires < Date.now()) return null
  return item.out
}

function sandboxCsp() {
  const hosts = config.renderAllowedHosts.map((h) => `https://${h}`).join(" ")
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

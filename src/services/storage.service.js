const fs = require("fs")
const path = require("path")

const root = () => path.resolve(process.env.STORAGE_DIR || "./storage")

function safeSegment(value) {
  const s = String(value)
  if (!/^[a-zA-Z0-9-]+$/.test(s)) throw new Error("Unsafe storage path segment")
  return s
}

// Returns the relative path stored in the database.
async function savePdf(organizationId, documentId, buffer) {
  const rel = path.join("pdf", safeSegment(organizationId), `${safeSegment(documentId)}.pdf`)
  const abs = path.join(root(), rel)
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  await fs.promises.writeFile(abs, buffer)
  return rel
}

// Original PDFs uploaded as templates, stored by their SHA-256 so they can't be swapped.
async function saveTemplateSource(organizationId, hash, buffer) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid hash")
  const rel = path.join("templates", safeSegment(organizationId), `${hash}.pdf`)
  const abs = path.join(root(), rel)
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  if (!fs.existsSync(abs)) await fs.promises.writeFile(abs, buffer)
  return rel
}

async function readTemplateSource(organizationId, hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash))) throw new Error("Invalid hash")
  return readFile(path.join("templates", safeSegment(organizationId), `${hash}.pdf`))
}

async function hasTemplateSource(organizationId, hash) {
  if (!/^[a-f0-9]{64}$/.test(String(hash))) return false
  return fs.existsSync(path.join(root(), "templates", safeSegment(organizationId), `${hash}.pdf`))
}

async function readFile(rel) {
  const abs = path.resolve(root(), rel)
  if (!abs.startsWith(root() + path.sep)) throw new Error("Invalid storage path")
  return fs.promises.readFile(abs)
}

module.exports = { savePdf, readFile, saveTemplateSource, readTemplateSource, hasTemplateSource }

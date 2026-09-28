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

async function readFile(rel) {
  const abs = path.resolve(root(), rel)
  if (!abs.startsWith(root() + path.sep)) throw new Error("Invalid storage path")
  return fs.promises.readFile(abs)
}

module.exports = { savePdf, readFile }

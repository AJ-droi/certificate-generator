// Small input checks shared by several services.
const { badRequest } = require("./errors")

const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/

// A logo or signature: a PNG/JPEG/WebP/GIF data URL of at most ~500 KB, or null to remove.
function cleanImage(value, label) {
  if (value === null || value === "") return null
  if (typeof value !== "string" || !IMAGE_RE.test(value)) throw badRequest(`${label} must be a PNG, JPEG, WebP or GIF image`)
  if (value.length > 700_000) throw badRequest(`${label} is too large (max ~500 KB)`)
  return value
}

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))

// For ILIKE searches: user text can't act as a wildcard.
const likePattern = (q, max = 100) => `%${String(q).slice(0, max).replace(/[%_\\]/g, "\\$&")}%`

module.exports = { cleanImage, isUuid, likePattern }

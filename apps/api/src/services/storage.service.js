// Files: issued PDFs and companies' uploaded PDF forms. Two drivers:
//   local — a folder (STORAGE_DIR). One server only.
//   s3    — any S3-compatible store (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO),
//           so several servers share the same files.
// Keys look like "pdf/<org-id>/<document-id>.pdf" and are what the database stores.
const fs = require("fs")
const path = require("path")
const { config } = require("../config")

function safeSegment(value) {
  const s = String(value)
  if (!/^[a-zA-Z0-9-]+$/.test(s)) throw new Error("Unsafe storage path segment")
  return s
}

const HASH_RE = /^[a-f0-9]{64}$/
const KEY_RE = /^(pdf|templates)\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.pdf$/

// Older rows may have OS-specific separators; keys always use "/".
function checkKey(key) {
  const k = String(key).split(path.sep).join("/")
  if (!KEY_RE.test(k)) throw new Error("Invalid storage key")
  return k
}

// ---- Drivers ------------------------------------------------------------------------

function localDriver() {
  const root = () => path.resolve(config.storage.dir)
  const abs = (key) => {
    const p = path.resolve(root(), key)
    if (!p.startsWith(root() + path.sep)) throw new Error("Invalid storage path")
    return p
  }
  return {
    name: "local",
    async put(key, buffer) {
      const p = abs(key)
      await fs.promises.mkdir(path.dirname(p), { recursive: true })
      // Write then rename, so a crash never leaves half a file under the real name.
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
      await fs.promises.writeFile(tmp, buffer)
      await fs.promises.rename(tmp, p)
    },
    get: (key) => fs.promises.readFile(abs(key)),
    async exists(key) {
      try {
        await fs.promises.access(abs(key))
        return true
      } catch {
        return false
      }
    },
    async check() {
      await fs.promises.mkdir(root(), { recursive: true })
      await fs.promises.access(root(), fs.constants.W_OK)
    },
  }
}

function s3Driver() {
  const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3")
  const s3 = config.storage.s3
  const client = new S3Client({
    region: s3.region,
    endpoint: s3.endpoint || undefined,
    forcePathStyle: s3.forcePathStyle,
    credentials: s3.accessKeyId ? { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey } : undefined,
  })
  const Key = (key) => (s3.prefix ? `${s3.prefix}/${key}` : key)
  const notFound = (err) => err && (err.name === "NotFound" || err.name === "NoSuchKey" || (err.$metadata && err.$metadata.httpStatusCode === 404))
  return {
    name: "s3",
    async put(key, buffer) {
      await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: Key(key), Body: buffer, ContentType: "application/pdf" }))
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: Key(key) }))
        return Buffer.from(await out.Body.transformToByteArray())
      } catch (err) {
        if (notFound(err)) throw Object.assign(new Error("File not found"), { code: "ENOENT" })
        throw err
      }
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: Key(key) }))
        return true
      } catch (err) {
        if (notFound(err)) return false
        throw err
      }
    },
    async check() {
      await client.send(new HeadBucketCommand({ Bucket: s3.bucket }))
    },
  }
}

let driver = null
let driverFor = null
function current() {
  const want = config.storage.driver
  // Rebuilt if any storage setting changes (tests switch them; harmless otherwise).
  const signature = JSON.stringify(config.storage)
  if (!driver || driverFor !== signature) {
    driver = want === "s3" ? s3Driver() : localDriver()
    driverFor = signature
  }
  return driver
}

// ---- API used by the rest of the app ---------------------------------------------------

// Returns the key stored in the database.
async function savePdf(organizationId, documentId, buffer) {
  const key = `pdf/${safeSegment(organizationId)}/${safeSegment(documentId)}.pdf`
  await current().put(key, buffer)
  return key
}

// Original PDFs uploaded as templates, stored by their SHA-256 so they can't be swapped.
async function saveTemplateSource(organizationId, hash, buffer) {
  if (!HASH_RE.test(hash)) throw new Error("Invalid hash")
  const key = `templates/${safeSegment(organizationId)}/${hash}.pdf`
  if (!(await current().exists(key))) await current().put(key, buffer)
  return key
}

const templateKey = (organizationId, hash) => {
  if (!HASH_RE.test(String(hash))) throw new Error("Invalid hash")
  return `templates/${safeSegment(organizationId)}/${hash}.pdf`
}

// Async throughout: a bad key is a rejected promise, never a synchronous throw.
const readTemplateSource = async (organizationId, hash) => current().get(templateKey(organizationId, hash))

async function hasTemplateSource(organizationId, hash) {
  if (!HASH_RE.test(String(hash))) return false
  return current().exists(templateKey(organizationId, hash))
}

const readFile = async (key) => current().get(checkKey(key))

// For the readiness check.
const checkStorage = () => current().check()
const storageDriverName = () => current().name

module.exports = { savePdf, readFile, saveTemplateSource, readTemplateSource, hasTemplateSource, checkStorage, storageDriverName }

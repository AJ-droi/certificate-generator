// End-to-end tests against a real Postgres database and headless Chrome.
//   PGDATABASE=certificate_generator_test npm test
// WARNING: wipes the tables in the database you point it at.
require("reflect-metadata")
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-test-"))
process.env.AUTH_RATE_LIMIT = "1000"
process.env.VERIFY_RATE_LIMIT = "1000"
process.env.LEGACY_ORG_SLUG = "acme-inspections"

const { createApp } = require("../src/app")
const { AppDataSource, initializeDatabase } = require("../src/config/database")
const { closeBrowser } = require("../src/services/pdf.service")
const { canonicalJson } = require("../src/lib/crypto")

let server
let base

// Minimal cookie-aware client.
function client() {
  let cookie = ""
  return async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      redirect: "manual",
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    })
    const set = res.headers.get("set-cookie")
    if (set) cookie = set.split(";")[0]
    const type = res.headers.get("content-type") || ""
    const data = type.includes("json") ? await res.json() : type.includes("pdf") ? Buffer.from(await res.arrayBuffer()) : await res.text()
    return { status: res.status, data, headers: res.headers }
  }
}

const SCHEMA = [
  { key: "employerName", label: "Employer", type: "text", required: true, showOnVerify: true },
  { key: "examDate", label: "Exam date", type: "date", required: true },
  { key: "items", label: "Items", type: "table", required: true, columns: [
    { key: "description", label: "Description", type: "text", required: true },
    { key: "safe", label: "Safe", type: "select", options: ["YES", "NO"] },
  ] },
]
const HTML = `<html><body><h1>{{org.name}}</h1><p>No {{document.no}}</p><p>{{employerName}}</p>
{{#each items}}<div>{{description}} {{safe}}</div>{{/each}}{{#if qr}}<img src="{{qr}}">{{/if}}</body></html>`
const DATA = { employerName: "Acme Construction", examDate: "2026-01-21", items: [{ description: "Harness", safe: "YES" }] }

const admin = client()
const approver = client()
const issuer = client()
const other = client()
const anon = client()
let templateId
let issuedDoc

before(async () => {
  const target = process.env.DATABASE_URL || process.env.PGDATABASE || ""
  if (!/test/i.test(target)) {
    throw new Error("Refusing to run: tests wipe the database. Point PGDATABASE (or DATABASE_URL) at a database with 'test' in its name.")
  }
  await initializeDatabase()
  await AppDataSource.query(
    "TRUNCATE organizations, users, templates, template_versions, documents, audit_events RESTART IDENTITY CASCADE",
  )
  server = createApp().listen(0)
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.close()
  await closeBrowser()
  await AppDataSource.destroy()
})

test("sign up creates a company with its own signing key", async () => {
  const r = await admin("POST", "/api/auth/signup", { orgName: "Acme Inspections", name: "Ada Admin", email: "ada@acme.test", password: "correct-horse-1" })
  assert.equal(r.status, 201)
  assert.equal(r.data.organization.slug, "acme-inspections")
  assert.match(r.data.organization.publicKey, /BEGIN PUBLIC KEY/)
  assert.equal(r.data.organization.privateKeyEnc, undefined)
  const dup = await anon("POST", "/api/auth/signup", { orgName: "X", name: "X", email: "ada@acme.test", password: "correct-horse-1" })
  assert.equal(dup.status, 409)
})

test("writes must be JSON (blocks cross-site form posts)", async () => {
  const r = await admin("POST", "/api/templates", "name=x", { "content-type": "application/x-www-form-urlencoded" })
  assert.equal(r.status, 415)
})

test("admin invites people; temporary passwords must be changed", async () => {
  const a = await admin("POST", "/api/users", { name: "Paul Approver", email: "paul@acme.test", role: "approver" })
  assert.equal(a.status, 201)
  const i = await admin("POST", "/api/users", { name: "Ivy Issuer", email: "ivy@acme.test", role: "issuer" })
  await approver("POST", "/api/auth/login", { email: "paul@acme.test", password: a.data.temporaryPassword })
  const blocked = await approver("GET", "/api/documents")
  assert.equal(blocked.status, 403)
  assert.equal((await approver("POST", "/api/auth/password", { currentPassword: a.data.temporaryPassword, newPassword: "approver-pass-1" })).status, 200)
  assert.equal((await approver("GET", "/api/documents")).status, 200)

  await issuer("POST", "/api/auth/login", { email: "ivy@acme.test", password: i.data.temporaryPassword })
  await issuer("POST", "/api/auth/password", { currentPassword: i.data.temporaryPassword, newPassword: "issuer-pass-12" })
  const bad = await anon("POST", "/api/auth/login", { email: "ivy@acme.test", password: "wrong-password" })
  assert.equal(bad.status, 401)
})

test("only admins manage templates; bad schemas and syntax are rejected", async () => {
  assert.equal((await issuer("POST", "/api/templates", { name: "T", html: HTML, schema: SCHEMA })).status, 403)
  const badSchema = await admin("POST", "/api/templates", { name: "T", html: HTML, schema: [{ key: "1bad", type: "text" }] })
  assert.equal(badSchema.status, 400)
  const badSyntax = await admin("POST", "/api/templates", { name: "T", html: "{{#if x}}", schema: SCHEMA })
  assert.equal(badSyntax.status, 400)
  const r = await admin("POST", "/api/templates", { name: "Inspection report", html: HTML, schema: SCHEMA, settings: { numberPrefix: "ACME-", numberPadding: 3 } })
  assert.equal(r.status, 201)
  templateId = r.data.template.id
  const preview = await admin("POST", "/api/templates/preview", { html: HTML, schema: SCHEMA, data: DATA })
  assert.match(preview.data.previewUrl, /^\/render\//)
  const page = await anon("GET", preview.data.previewUrl)
  assert.match(page.data, /Acme Construction/)
  assert.match(page.headers.get("content-security-policy"), /sandbox/)
})

test("full lifecycle: draft → submit → approve (four-eyes) → verify", async () => {
  const created = await issuer("POST", "/api/documents", { templateId, data: { ...DATA, employerName: "" } })
  assert.equal(created.status, 201)
  const doc = created.data.document
  assert.equal(doc.documentNo, "ACME-001")
  assert.equal(doc.publicId, null)

  // Required field missing -> can't submit
  assert.equal((await issuer("POST", `/api/documents/${doc.id}/submit`, {})).status, 400)
  assert.equal((await issuer("PATCH", `/api/documents/${doc.id}`, { data: DATA })).status, 200)
  // Approver can't approve an unsubmitted draft of someone else
  assert.equal((await approver("POST", `/api/documents/${doc.id}/approve`, {})).status, 409)
  assert.equal((await issuer("POST", `/api/documents/${doc.id}/submit`, {})).status, 200)
  // Issuers can't approve; drafts can't be edited once submitted
  assert.equal((await issuer("POST", `/api/documents/${doc.id}/approve`, {})).status, 403)
  assert.equal((await issuer("PATCH", `/api/documents/${doc.id}`, { data: DATA })).status, 409)

  const issued = await approver("POST", `/api/documents/${doc.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  issuedDoc = issued.data.document
  assert.equal(issuedDoc.status, "issued")
  assert.match(issuedDoc.publicId, /^[0-9A-Z]{24}$/)
  assert.equal(issuedDoc.signedPayload.approvedBy.name, "Paul Approver")
  assert.equal(issuedDoc.signedPayload.preparedBy.name, "Ivy Issuer")

  // Locked after issue
  assert.equal((await admin("PATCH", `/api/documents/${doc.id}`, { data: DATA })).status, 409)

  const pdf = await issuer("GET", `/api/documents/${doc.id}/pdf`)
  assert.equal(pdf.status, 200)
  assert.equal(crypto.createHash("sha256").update(pdf.data).digest("hex"), issuedDoc.pdfHash)

  const v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "valid")
  assert.deepEqual(v.data.checks, { signatureValid: true, hashMatches: true, recordMatches: true, pdfMatches: true })

  // The signature checks out independently with just the public key
  const key = await anon("GET", "/api/public/orgs/acme-inspections/key")
  const ok = crypto.verify(null, Buffer.from(canonicalJson(v.data.signedPayload)), crypto.createPublicKey(key.data.publicKey), Buffer.from(v.data.signature, "base64"))
  assert.equal(ok, true)

  const page = await anon("GET", `/v/${issuedDoc.publicId}`)
  assert.match(page.data, /Valid document/)
  assert.match(page.data, /Acme Construction/)
  // Lower-case / dashed codes still resolve
  const dashed = issuedDoc.publicId.toLowerCase().match(/.{4}/g).join("-")
  assert.equal((await anon("GET", `/v/${dashed}`)).status, 301)
  const docPage = await anon("GET", `/v/${issuedDoc.publicId}/document`)
  assert.match(docPage.headers.get("content-security-policy"), /sandbox/)
})

test("four-eyes: a person can't approve their own document", async () => {
  const d = (await approver("POST", "/api/documents", { templateId, data: DATA })).data.document
  await approver("POST", `/api/documents/${d.id}/submit`, {})
  const r = await approver("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(r.status, 403)
})

test("drafts and unknown codes are not visible publicly", async () => {
  const d = (await issuer("POST", "/api/documents", { templateId, data: DATA })).data.document
  assert.equal((await anon("GET", `/api/public/verify/${d.id}`)).status, 404)
  assert.equal((await anon("GET", "/v/AAAAAAAAAAAAAAAAAAAAAAAA")).status, 404)
})

test("editing the database directly is detected", async () => {
  const [row] = await AppDataSource.query("SELECT data FROM documents WHERE id = $1", [issuedDoc.id])
  const forged = { ...row.data, employerName: "Forged Ltd" }
  await AppDataSource.query("UPDATE documents SET data = $2 WHERE id = $1", [issuedDoc.id, JSON.stringify(forged)])
  let v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "tampered")
  assert.equal(v.data.checks.recordMatches, false)

  // Changing the signed copy too breaks the signature
  await AppDataSource.query(
    "UPDATE documents SET signed_payload = jsonb_set(signed_payload, '{data}', $2::jsonb) WHERE id = $1",
    [issuedDoc.id, JSON.stringify(forged)],
  )
  v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "tampered")
  assert.equal(v.data.checks.signatureValid, false)
  const page = await anon("GET", `/v/${issuedDoc.publicId}`)
  assert.match(page.data, /Failed integrity check/)

  // Restore
  await AppDataSource.query(
    "UPDATE documents SET data = $2, signed_payload = jsonb_set(signed_payload, '{data}', $2::jsonb) WHERE id = $1",
    [issuedDoc.id, JSON.stringify(row.data)],
  )
  assert.equal((await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)).data.verdict, "valid")
})

test("a replaced PDF file is detected", async () => {
  const [row] = await AppDataSource.query("SELECT pdf_path FROM documents WHERE id = $1", [issuedDoc.id])
  const file = path.join(process.env.STORAGE_DIR, row.pdf_path)
  const original = fs.readFileSync(file)
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from("%tampered")]))
  assert.equal((await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)).data.checks.pdfMatches, false)
  fs.writeFileSync(file, original)
})

test("correction supersedes the original once issued", async () => {
  const c = await issuer("POST", `/api/documents/${issuedDoc.id}/correct`, {})
  assert.equal(c.status, 201)
  const draft = c.data.document
  assert.equal(draft.documentNo, "ACME-001-R1")
  assert.equal((await issuer("POST", `/api/documents/${issuedDoc.id}/correct`, {})).status, 409)
  await issuer("PATCH", `/api/documents/${draft.id}`, { data: { ...DATA, employerName: "Acme Construction Ltd" } })
  await issuer("POST", `/api/documents/${draft.id}/submit`, {})
  const r = await approver("POST", `/api/documents/${draft.id}/approve`, {})
  assert.equal(r.status, 200)

  const old = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(old.data.verdict, "superseded")
  assert.equal(old.data.replacement.documentNo, "ACME-001-R1")
  assert.equal((await anon("GET", `/api/public/verify/${r.data.document.publicId}`)).data.verdict, "valid")
  issuedDoc = r.data.document
})

test("revoking shows the reason publicly", async () => {
  assert.equal((await issuer("POST", `/api/documents/${issuedDoc.id}/revoke`, { reason: "x" })).status, 403)
  assert.equal((await approver("POST", `/api/documents/${issuedDoc.id}/revoke`, {})).status, 400)
  const r = await approver("POST", `/api/documents/${issuedDoc.id}/revoke`, { reason: "Harness failed re-test" })
  assert.equal(r.status, 200)
  const v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "revoked")
  assert.equal(v.data.revokeReason, "Harness failed re-test")
  const page = await anon("GET", `/v/${issuedDoc.publicId}`)
  assert.match(page.data, /Revoked/)
})

test("companies can't see each other's data", async () => {
  await other("POST", "/api/auth/signup", { orgName: "Other Co", name: "Olu", email: "olu@other.test", password: "other-pass-123" })
  assert.equal((await other("GET", `/api/documents/${issuedDoc.id}`)).status, 404)
  assert.equal((await other("GET", `/api/templates/${templateId}`)).status, 404)
  assert.equal((await other("POST", "/api/documents", { templateId, data: DATA })).status, 404)
  assert.equal((await other("POST", `/api/documents/${issuedDoc.id}/revoke`, { reason: "x" })).status, 404)
  assert.equal((await other("GET", "/api/documents")).data.total, 0)
  const users = await other("GET", "/api/users")
  assert.equal(users.data.users.length, 1)
})

test("templates can't reach local files or internal services when the PDF is made", async () => {
  const http = require("node:http")
  let hits = 0
  const internal = http.createServer((req, res) => { hits++; res.end("secret") }).listen(0, "127.0.0.1")
  await new Promise((r) => internal.once("listening", r))
  const port = internal.address().port
  const secretFile = path.join(process.env.STORAGE_DIR, "secret.txt")
  fs.writeFileSync(secretFile, "TOP-SECRET-VALUE")
  const html = `<html><body><p>hello</p>
    <iframe src="file://${secretFile}"></iframe>
    <img src="http://127.0.0.1:${port}/img.png">
    <link rel="stylesheet" href="http://127.0.0.1:${port}/style.css">
    <script>fetch("http://127.0.0.1:${port}/js").catch(()=>{}); document.write('<iframe src="file://${secretFile}"></iframe>')</script>
  </body></html>`
  const t = await other("POST", "/api/templates", { name: "Evil", html, schema: [{ key: "a", label: "A", type: "text" }] })
  assert.equal(t.status, 201)
  assert.equal((await other("PATCH", "/api/org", { requireSeparateApprover: false })).status, 200)
  const d = (await other("POST", "/api/documents", { templateId: t.data.template.id, data: { a: "x" } })).data.document
  const issued = await other("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  internal.close()
  assert.equal(hits, 0, "the headless browser reached an internal service")

  const { isAllowed } = require("../src/services/pdf.service")
  const hosts = new Set(["cdn.jsdelivr.net"])
  assert.equal(isAllowed(`file://${secretFile}`, hosts), false)
  assert.equal(isAllowed("http://169.254.169.254/latest/meta-data", hosts), false)
  assert.equal(isAllowed("http://cdn.jsdelivr.net/x.css", hosts), false)
  assert.equal(isAllowed("https://cdn.jsdelivr.net/x.css", hosts), true)
  assert.equal(isAllowed("data:image/png;base64,AAAA", hosts), true)
})

test("QR codes printed by the old system redirect to the verify page", async () => {
  await AppDataSource.query("UPDATE documents SET document_no = 'ELS/MTC-HB-001-0126' WHERE id = $1", [issuedDoc.id])
  const r = await anon("GET", "/report/ELS%2FMTC-HB-001-0126")
  assert.equal(r.status, 302)
  assert.equal(r.headers.get("location"), `/v/${issuedDoc.publicId}`)
  assert.equal((await anon("GET", "/report/NOPE-1")).status, 404)
})

test("every action is in the audit log", async () => {
  const r = await admin("GET", "/api/audit")
  const actions = new Set(r.data.events.map((e) => e.action))
  for (const a of ["document.created", "document.submitted", "document.issued", "document.revoked", "document.superseded", "document.verified", "user.created"]) {
    assert.ok(actions.has(a), `missing ${a}`)
  }
  assert.equal((await issuer("GET", "/api/audit")).status, 403)
})

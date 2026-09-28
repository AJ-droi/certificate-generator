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
  const call = async function (method, url, body, headers = {}) {
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
    if (set) {
      cookie = set.split(";")[0]
      call.cookie = cookie
    }
    const type = res.headers.get("content-type") || ""
    const data = type.includes("json") ? await res.json() : type.includes("pdf") ? Buffer.from(await res.arrayBuffer()) : await res.text()
    return { status: res.status, data, headers: res.headers }
  }
  return call
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

// ---- PDF form templates -------------------------------------------------------------

const { makeSampleForm } = require("../scripts/make-sample-form")

async function pdfText(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const fonts = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + "/"
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, standardFontDataUrl: fonts, verbosity: 0 }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent()
    pages.push(content.items.map((it) => it.str).join(" "))
  }
  return pages
}

async function uploadPdf(call, buffer) {
  const res = await fetch(base + "/api/templates/pdf-source", {
    method: "POST",
    headers: { "content-type": "application/pdf", cookie: call.cookie },
    body: buffer,
  })
  return { status: res.status, data: await res.json() }
}

const pdfAdmin = client()
let pdfTemplateId
let pdfSourceHash

test("PDF upload: rejects non-PDFs and finds fillable form fields", async () => {
  await pdfAdmin("POST", "/api/auth/signup", { orgName: "Pdf Co", name: "Pam", email: "pam@pdf.test", password: "pdf-pass-1234" })
  // Grab the session cookie for raw uploads.
  const me = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pam@pdf.test", password: "pdf-pass-1234" }) })
  pdfAdmin.cookie = me.headers.get("set-cookie").split(";")[0]

  const notPdf = await uploadPdf(pdfAdmin, Buffer.from("%PNG this is not a pdf file at all, just some bytes padding padding padding padding"))
  assert.equal(notPdf.status, 400)

  const issuerUpload = await fetch(base + "/api/templates/pdf-source", { method: "POST", headers: { "content-type": "application/pdf" }, body: await makeSampleForm() })
  assert.equal(issuerUpload.status, 401)

  const r = await uploadPdf(pdfAdmin, await makeSampleForm({ fillable: true }))
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.pageCount, 1)
  assert.match(r.data.sourceHash, /^[a-f0-9]{64}$/)
  const names = r.data.formFields.map((f) => f.name).sort()
  assert.deepEqual(names, ["client_name", "result.accepted"])
  const client = r.data.formFields.find((f) => f.name === "client_name")
  assert.equal(client.type, "text")
  assert.ok(Math.abs(client.x - 380) < 1 && Math.abs(client.w - 185) < 1, JSON.stringify(client))
  pdfSourceHash = r.data.sourceHash
})

test("PDF template: layout is validated against the fields and pages", async () => {
  const schema = [{ key: "client", label: "Client", type: "text", required: true }]
  const bad = await pdfAdmin("POST", "/api/templates", {
    name: "Bad", kind: "pdf", sourceHash: pdfSourceHash, schema,
    layout: { items: [{ kind: "field", key: "nope", page: 0, x: 10, y: 10, w: 50, h: 12 }, { kind: "field", key: "client", page: 3, x: 10, y: 10, w: 50, h: 12 }] },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.data.details.errors.length, 2)
  const missing = await pdfAdmin("POST", "/api/templates", { name: "X", kind: "pdf", sourceHash: "0".repeat(64), schema, layout: { items: [] } })
  assert.equal(missing.status, 400)
})

test("PDF template: issuing prints data onto the original pages, extra rows continue", async () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "seeds", "pressure-test", "template.json"), "utf8"))
  const up = await uploadPdf(pdfAdmin, await makeSampleForm())
  const created = await pdfAdmin("POST", "/api/templates", { ...tpl, kind: "pdf", sourceHash: up.data.sourceHash })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal(created.data.version.kind, "pdf")
  assert.deepEqual(created.data.unplaced, [])
  pdfTemplateId = created.data.template.id

  // A placement off the edge of the page is pulled back onto it.
  const clamp = await pdfAdmin("POST", "/api/templates/preview", {
    kind: "pdf", sourceHash: up.data.sourceHash, schema: tpl.schema,
    layout: { items: [{ kind: "field", key: "client", page: 0, x: 590, y: 10, w: 100, h: 12 }] }, data: {},
  })
  assert.equal(clamp.status, 200)
  assert.equal(clamp.data.kind, "pdf")

  await pdfAdmin("PATCH", "/api/org", { requireSeparateApprover: false })
  const data = { ...tpl.settings.sampleData, client: "Zenith Offshore Ltd", items: Array.from({ length: 15 }, (_, i) => ({ tag: `TAG-${i + 1}`, description: `Spool ${i + 1}`, size: "4\"", rating: "300#", result: "PASS", remarks: "" })) }
  const d = (await pdfAdmin("POST", "/api/documents", { templateId: pdfTemplateId, data })).data.document
  assert.equal(d.documentNo, "PT/0001")

  const draftPreview = await pdfAdmin("GET", `/api/documents/${d.id}/render`)
  assert.equal(draftPreview.data.kind, "pdf")
  const draftPdf = await anon("GET", draftPreview.data.previewUrl)
  const draftText = (await pdfText(draftPdf.data)).join(" ")
  assert.match(draftText, /DRAFT/)
  assert.match(draftText, /Awaiting approval/, "drafts say the approval is pending")

  const issued = await pdfAdmin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  const pdf = (await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data
  const pages = await pdfText(pdf)
  assert.equal(pages.length, 2, "15 rows with 12 per page should make 2 pages")
  assert.match(pages[0], /Zenith Offshore Ltd/)
  assert.match(pages[0], /PT\/0001/)
  assert.match(pages[0], /TAG-12/)
  assert.doesNotMatch(pages[0], /TAG-13/)
  assert.match(pages[1], /TAG-13/)
  assert.match(pages[1], /TAG-15/)
  assert.match(pages[1], /Zenith Offshore Ltd/, "header fields repeat on continuation pages")
  assert.match(pages[0], /PRESSURE TEST CERTIFICATE/, "the original form is underneath")
  assert.doesNotMatch(pages.join(" "), /DRAFT/)
  assert.doesNotMatch(pages.join(" "), /Awaiting approval/)
  assert.match(pages[0], /Pam/, "approver's name printed once approved")
  const code = issued.data.document.publicId.match(/.{4}/g).join("-")
  assert.ok(pages[0].includes(code), "verification code printed")

  const v = await anon("GET", `/api/public/verify/${issued.data.document.publicId}`)
  assert.equal(v.data.verdict, "valid")
  assert.equal(v.data.checks.recordMatches, true)
  const docView = await anon("GET", `/v/${issued.data.document.publicId}/document`)
  assert.equal(docView.headers.get("content-type"), "application/pdf")
})

test("PDF template: fillable fields are flattened, and the stored form can't be swapped", async () => {
  const up = await uploadPdf(pdfAdmin, await makeSampleForm({ fillable: true }))
  const schema = [{ key: "client", label: "Client", type: "text" }]
  const t = await pdfAdmin("POST", "/api/templates", {
    name: "Fillable", kind: "pdf", sourceHash: up.data.sourceHash, schema,
    layout: { items: [{ kind: "field", key: "client", page: 0, x: 380, y: 125, w: 185, h: 13 }, { kind: "system", key: "qr", page: 0, x: 496, y: 39, w: 56, h: 56 }] },
  })
  const d = (await pdfAdmin("POST", "/api/documents", { templateId: t.data.template.id, data: { client: "Flat Co" } })).data.document
  await pdfAdmin("POST", `/api/documents/${d.id}/approve`, {})
  const pdf = (await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data
  const { PDFDocument } = require("pdf-lib")
  const out = await PDFDocument.load(pdf)
  assert.equal(out.getForm().getFields().length, 0, "no editable form fields left in the issued PDF")
  const annots = out.getPage(0).node.Annots()
  assert.ok(!annots || annots.size() === 0, "no annotations/widgets left")

  // Swap the stored blank form: rendering refuses rather than printing on the wrong design.
  const [row] = await AppDataSource.query("SELECT organization_id FROM template_versions WHERE template_id = $1", [t.data.template.id])
  const file = path.join(process.env.STORAGE_DIR, "templates", row.organization_id, `${up.data.sourceHash}.pdf`)
  const original = fs.readFileSync(file)
  fs.writeFileSync(file, await makeSampleForm())
  const r = await pdfAdmin("GET", `/api/documents/${d.id}/render`)
  assert.equal(r.status, 500)
  fs.writeFileSync(file, original)
  assert.equal((await pdfAdmin("GET", `/api/documents/${d.id}/render`)).status, 200)

  // Other companies can't read this company's uploaded form.
  assert.equal((await other("GET", `/api/templates/pdf-source/${up.data.sourceHash}`)).status, 404)
})

test("PDF template: an erased copy keeps a link to the original upload", async () => {
  const original = await uploadPdf(pdfAdmin, await makeSampleForm())
  const cleaned = await uploadPdf(pdfAdmin, await makeSampleForm({ fillable: true })) // stands in for the erased copy
  const schema = [{ key: "client", label: "Client", type: "text" }]
  const items = [{ kind: "field", key: "client", page: 0, x: 380, y: 125, w: 185, h: 13, erase: true, eraseColor: "#FFFFFF" }]
  const t = await pdfAdmin("POST", "/api/templates", {
    name: "Erased", kind: "pdf", sourceHash: cleaned.data.sourceHash, schema,
    layout: { items, originalSourceHash: original.data.sourceHash },
  })
  assert.equal(t.status, 201, JSON.stringify(t.data))
  assert.equal(t.data.version.layout.originalSourceHash, original.data.sourceHash)
  assert.equal(t.data.version.layout.items[0].erase, true)
  assert.equal(t.data.version.layout.items[0].eraseColor, "#ffffff")
  // An original that was never uploaded is dropped.
  const bogus = await pdfAdmin("POST", `/api/templates/${t.data.template.id}/versions`, {
    kind: "pdf", sourceHash: cleaned.data.sourceHash, schema, layout: { items, originalSourceHash: "a".repeat(64) },
  })
  assert.equal(bogus.data.version.layout.originalSourceHash, undefined)
})

test("PDF template: text style per box, and drafts follow template changes", async () => {
  const up = await uploadPdf(pdfAdmin, await makeSampleForm())
  const schema = [{ key: "client", label: "Client", type: "text" }]
  const item = { kind: "field", key: "client", page: 0, x: 380, y: 120, w: 185, h: 20, font: "serif", bold: true, color: "#1A2B3C" }
  const t = await pdfAdmin("POST", "/api/templates", { name: "Styled", kind: "pdf", sourceHash: up.data.sourceHash, schema, layout: { items: [item] } })
  assert.equal(t.status, 201, JSON.stringify(t.data))
  const saved = t.data.version.layout.items[0]
  assert.deepEqual([saved.font, saved.bold, saved.color], ["serif", true, "#1a2b3c"])

  const d = (await pdfAdmin("POST", "/api/documents", { templateId: t.data.template.id, data: { client: "Styled Ltd" } })).data.document
  const draftVersion = d.templateVersionId

  // The admin changes the template: a new field.
  const v2 = await pdfAdmin("POST", `/api/templates/${t.data.template.id}/versions`, {
    kind: "pdf", sourceHash: up.data.sourceHash,
    schema: [...schema, { key: "site", label: "Site", type: "text" }],
    layout: { items: [item, { kind: "field", key: "site", page: 0, x: 30, y: 160, w: 300, h: 16 }] },
  })
  assert.equal(v2.status, 201)
  // The open draft shows the new field straight away and moves to v2 on save.
  const view = await pdfAdmin("GET", `/api/documents/${d.id}`)
  assert.ok(view.data.version.schema.some((f) => f.key === "site"))
  const saved2 = await pdfAdmin("PATCH", `/api/documents/${d.id}`, { data: { client: "Styled Ltd", site: "Onne" } })
  assert.equal(saved2.status, 200, JSON.stringify(saved2.data))
  assert.notEqual(saved2.data.document.templateVersionId, draftVersion)
  assert.equal(saved2.data.document.templateVersionId, v2.data.version.id)
  assert.equal(saved2.data.document.data.site, "Onne")

  const issued = await pdfAdmin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  const text = (await pdfText((await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data)).join(" ")
  assert.match(text, /Styled Ltd/)
  assert.match(text, /Onne/)
  const { PDFDocument } = require("pdf-lib")
  const out = await PDFDocument.load((await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data)
  const fonts = [...out.context.enumerateIndirectObjects()].map(([, o]) => o && o.get && o.get(require("pdf-lib").PDFName.of("BaseFont"))).filter(Boolean).map(String)
  assert.ok(fonts.some((f) => /Times-Bold/.test(f)), `expected Times-Bold, got ${fonts}`)
})

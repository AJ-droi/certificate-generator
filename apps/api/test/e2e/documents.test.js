// Templates and the document lifecycle: draft, approval, signing, the official
// PDF (made in the background), verification, tampering, corrections, revocation.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const h = require("../helpers")
const { canonicalJson } = require("../../src/lib/crypto")

let acme
let templateId
let issuedDoc
const anon = h.client()

before(async () => {
  await h.startApp()
  acme = await h.createCompany({ name: "Acme Inspections", domain: "acme.test" })
  process.env.LEGACY_ORG_SLUG = acme.slug
})
after(() => h.stopApp())

test("only admins manage templates; bad schemas and syntax are rejected", async () => {
  assert.equal((await acme.issuer("POST", "/api/templates", { name: "T", html: h.HTML, schema: h.SCHEMA })).status, 403)
  const badSchema = await acme.admin("POST", "/api/templates", { name: "T", html: h.HTML, schema: [{ key: "1bad", type: "text" }] })
  assert.equal(badSchema.status, 400)
  const badSyntax = await acme.admin("POST", "/api/templates", { name: "T", html: "{{#if x}}", schema: h.SCHEMA })
  assert.equal(badSyntax.status, 400)
  const r = await acme.admin("POST", "/api/templates", { name: "Inspection report", html: h.HTML, schema: h.SCHEMA, settings: { numberPrefix: "ACME-", numberPadding: 3 } })
  assert.equal(r.status, 201)
  templateId = r.data.template.id
  const preview = await acme.admin("POST", "/api/templates/preview", { html: h.HTML, schema: h.SCHEMA, data: h.DATA })
  assert.match(preview.data.previewUrl, /^\/render\//)
  const page = await anon("GET", preview.data.previewUrl)
  assert.match(page.data, /Acme Construction/)
  assert.match(page.headers.get("content-security-policy"), /sandbox/)
})

test("full lifecycle: draft → submit → approve (four-eyes) → PDF in the background → verify", async () => {
  const { issuer, approver, admin } = acme
  const created = await issuer("POST", "/api/documents", { templateId, data: { ...h.DATA, employerName: "" } })
  assert.equal(created.status, 201)
  const doc = created.data.document
  assert.equal(doc.documentNo, "ACME-001")
  assert.equal(doc.publicId, null)

  // Required field missing -> can't submit
  assert.equal((await issuer("POST", `/api/documents/${doc.id}/submit`, {})).status, 400)
  assert.equal((await issuer("PATCH", `/api/documents/${doc.id}`, { data: h.DATA })).status, 200)
  // Approver can't approve an unsubmitted draft of someone else
  assert.equal((await approver("POST", `/api/documents/${doc.id}/approve`, {})).status, 409)
  assert.equal((await issuer("POST", `/api/documents/${doc.id}/submit`, {})).status, 200)
  // Issuers can't approve; drafts can't be edited once submitted
  assert.equal((await issuer("POST", `/api/documents/${doc.id}/approve`, {})).status, 403)
  assert.equal((await issuer("PATCH", `/api/documents/${doc.id}`, { data: h.DATA })).status, 409)

  const issued = await approver("POST", `/api/documents/${doc.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  issuedDoc = issued.data.document
  assert.equal(issuedDoc.status, "issued")
  assert.equal(issuedDoc.pdfStatus, "pending")
  assert.match(issuedDoc.publicId, /^[0-9A-Z]{24}$/)
  assert.equal(issuedDoc.signedPayload.approvedBy.name, "Paul Approver")
  assert.equal(issuedDoc.signedPayload.preparedBy.name, "Ivy Issuer")
  assert.deepEqual(issuedDoc.signedPayload.org.verified, {
    legalName: "Acme Inspections Limited", registrationNumber: "RC 123456", registrationCountry: "NG", domain: "acme.test",
  })
  // Locked after issue
  assert.equal((await admin("PATCH", `/api/documents/${doc.id}`, { data: h.DATA })).status, 409)

  // Before the PDF job runs: signed and verifiable, PDF not available yet.
  const early = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(early.data.verdict, "valid")
  assert.equal(early.data.pdfStatus, "pending")
  assert.equal(early.data.checks.pdfMatches, null)
  assert.equal((await issuer("GET", `/api/documents/${doc.id}/pdf`)).status, 409)
  assert.equal((await anon("GET", `/v/${issuedDoc.publicId}/pdf`)).status, 503)
  assert.match((await anon("GET", `/v/${issuedDoc.publicId}`)).data, /still being prepared/)

  assert.equal(await h.settle(), 1)
  const pdf = await issuer("GET", `/api/documents/${doc.id}/pdf`)
  assert.equal(pdf.status, 200)
  const [row] = await h.db.query("SELECT pdf_hash, pdf_status FROM documents WHERE id = $1", [doc.id])
  assert.equal(row.pdf_status, "ready")
  assert.equal(crypto.createHash("sha256").update(pdf.data).digest("hex"), row.pdf_hash)

  const v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "valid")
  assert.deepEqual(v.data.checks, { signatureValid: true, hashMatches: true, recordMatches: true, pdfMatches: true })

  // The signature checks out independently with just the public key
  const key = await anon("GET", `/api/public/orgs/${acme.slug}/key`)
  const ok = crypto.verify(null, Buffer.from(canonicalJson(v.data.signedPayload)), crypto.createPublicKey(key.data.publicKey), Buffer.from(v.data.signature, "base64"))
  assert.equal(ok, true)

  const page = await anon("GET", `/v/${issuedDoc.publicId}`)
  assert.match(page.data, /Valid document/)
  assert.match(page.data, /Acme Construction/)
  assert.match(page.data, /Acme Inspections Limited/)
  assert.match(page.data, /acme\.test/)
  assert.match(page.data, /RC 123456 \(Nigeria\)/)
  // Lower-case / dashed codes still resolve
  const dashed = issuedDoc.publicId.toLowerCase().match(/.{4}/g).join("-")
  assert.equal((await anon("GET", `/v/${dashed}`)).status, 301)
  const docPage = await anon("GET", `/v/${issuedDoc.publicId}/document`)
  assert.match(docPage.headers.get("content-security-policy"), /sandbox/)
  assert.equal((await anon("GET", `/v/${issuedDoc.publicId}/pdf`)).status, 200)
})

test("four-eyes: a person can't approve their own document", async () => {
  const d = (await acme.approver("POST", "/api/documents", { templateId, data: h.DATA })).data.document
  await acme.approver("POST", `/api/documents/${d.id}/submit`, {})
  assert.equal((await acme.approver("POST", `/api/documents/${d.id}/approve`, {})).status, 403)
})

test("a draft can be deleted (a DELETE with no body, as the dashboard sends it)", async () => {
  const d = (await acme.issuer("POST", "/api/documents", { templateId, data: h.DATA })).data.document
  assert.equal((await acme.approver("DELETE", `/api/documents/${d.id}`)).status, 403, "only its author or an admin")
  assert.equal((await acme.issuer("DELETE", `/api/documents/${d.id}`)).status, 200)
  assert.equal((await acme.issuer("GET", `/api/documents/${d.id}`)).status, 404)
})

test("drafts and unknown codes are not visible publicly", async () => {
  const d = (await acme.issuer("POST", "/api/documents", { templateId, data: h.DATA })).data.document
  assert.equal((await anon("GET", `/api/public/verify/${d.id}`)).status, 404)
  assert.equal((await anon("GET", "/v/AAAAAAAAAAAAAAAAAAAAAAAA")).status, 404)
})

test("editing the database directly is detected", async () => {
  const [row] = await h.db.query("SELECT data FROM documents WHERE id = $1", [issuedDoc.id])
  const forged = { ...row.data, employerName: "Forged Ltd" }
  await h.db.query("UPDATE documents SET data = $2 WHERE id = $1", [issuedDoc.id, JSON.stringify(forged)])
  let v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "tampered")
  assert.equal(v.data.checks.recordMatches, false)

  // Changing the signed copy too breaks the signature
  await h.db.query("UPDATE documents SET signed_payload = jsonb_set(signed_payload, '{data}', $2::jsonb) WHERE id = $1", [issuedDoc.id, JSON.stringify(forged)])
  v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "tampered")
  assert.equal(v.data.checks.signatureValid, false)
  assert.match((await anon("GET", `/v/${issuedDoc.publicId}`)).data, /Failed integrity check/)

  await h.db.query(
    "UPDATE documents SET data = $2, signed_payload = jsonb_set(signed_payload, '{data}', $2::jsonb) WHERE id = $1",
    [issuedDoc.id, JSON.stringify(row.data)],
  )
  assert.equal((await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)).data.verdict, "valid")
})

test("a replaced PDF file is detected", async () => {
  const [row] = await h.db.query("SELECT pdf_path FROM documents WHERE id = $1", [issuedDoc.id])
  const file = path.join(process.env.STORAGE_DIR, row.pdf_path)
  const original = fs.readFileSync(file)
  fs.writeFileSync(file, Buffer.concat([original, Buffer.from("%tampered")]))
  const v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.checks.pdfMatches, false)
  assert.equal(v.data.verdict, "tampered")
  fs.writeFileSync(file, original)
})

test("a PDF that fails to render is retried, marked failed, and can be retried by an approver", async () => {
  const storage = require("../../src/services/storage.service")
  const savePdf = storage.savePdf
  storage.savePdf = async () => {
    throw new Error("disk full")
  }
  try {
    const doc = await h.issueDocument(acme, templateId)
    // First attempt fails and is rescheduled with a delay.
    await h.settle()
    let [job] = await h.db.query("SELECT status, attempts, last_error, run_at > now() AS later FROM jobs WHERE payload->>'documentId' = $1", [doc.id])
    assert.deepEqual([job.status, job.attempts, job.later], ["queued", 1, true])
    assert.match(job.last_error, /disk full/)
    // Pretend the remaining attempts are used up.
    await h.db.query("UPDATE jobs SET run_at = now(), max_attempts = 2 WHERE payload->>'documentId' = $1", [doc.id])
    await h.settle()
    ;[job] = await h.db.query("SELECT status FROM jobs WHERE payload->>'documentId' = $1", [doc.id])
    assert.equal(job.status, "failed")
    const detail = await acme.issuer("GET", `/api/documents/${doc.id}`)
    assert.equal(detail.data.document.pdfStatus, "failed")
    // Still signed and valid; there's just no PDF yet.
    assert.equal((await anon("GET", `/api/public/verify/${doc.publicId}`)).data.verdict, "valid")

    storage.savePdf = savePdf
    assert.equal((await acme.issuer("POST", `/api/documents/${doc.id}/retry-pdf`, {})).status, 403)
    const retry = await acme.approver("POST", `/api/documents/${doc.id}/retry-pdf`, {})
    assert.equal(retry.status, 200)
    assert.equal(retry.data.document.pdfStatus, "pending")
    assert.equal((await acme.approver("POST", `/api/documents/${doc.id}/retry-pdf`, {})).status, 409)
    await h.settle()
    assert.equal((await acme.issuer("GET", `/api/documents/${doc.id}/pdf`)).status, 200)
  } finally {
    storage.savePdf = savePdf
  }
})

test("correction supersedes the original once issued", async () => {
  const c = await acme.issuer("POST", `/api/documents/${issuedDoc.id}/correct`, {})
  assert.equal(c.status, 201)
  const draft = c.data.document
  assert.equal(draft.documentNo, "ACME-001-R1")
  assert.equal((await acme.issuer("POST", `/api/documents/${issuedDoc.id}/correct`, {})).status, 409)
  await acme.issuer("PATCH", `/api/documents/${draft.id}`, { data: { ...h.DATA, employerName: "Acme Construction Ltd" } })
  await acme.issuer("POST", `/api/documents/${draft.id}/submit`, {})
  const r = await acme.approver("POST", `/api/documents/${draft.id}/approve`, {})
  assert.equal(r.status, 200)
  await h.settle()

  const old = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(old.data.verdict, "superseded")
  assert.equal(old.data.replacement.documentNo, "ACME-001-R1")
  assert.equal((await anon("GET", `/api/public/verify/${r.data.document.publicId}`)).data.verdict, "valid")
  issuedDoc = r.data.document
})

test("revoking shows the reason publicly", async () => {
  assert.equal((await acme.issuer("POST", `/api/documents/${issuedDoc.id}/revoke`, { reason: "x" })).status, 403)
  assert.equal((await acme.approver("POST", `/api/documents/${issuedDoc.id}/revoke`, {})).status, 400)
  const r = await acme.approver("POST", `/api/documents/${issuedDoc.id}/revoke`, { reason: "Harness failed re-test" })
  assert.equal(r.status, 200)
  const v = await anon("GET", `/api/public/verify/${issuedDoc.publicId}`)
  assert.equal(v.data.verdict, "revoked")
  assert.equal(v.data.revokeReason, "Harness failed re-test")
  assert.match((await anon("GET", `/v/${issuedDoc.publicId}`)).data, /Revoked/)
})

test("QR codes printed by the old system redirect to the verify page", async () => {
  await h.db.query("UPDATE documents SET document_no = 'ELS/MTC-HB-001-0126' WHERE id = $1", [issuedDoc.id])
  const r = await anon("GET", "/report/ELS%2FMTC-HB-001-0126")
  assert.equal(r.status, 302)
  assert.equal(r.headers.get("location"), `/v/${issuedDoc.publicId}`)
  assert.equal((await anon("GET", "/report/NOPE-1")).status, 404)
})

test("every action is in the activity log", async () => {
  const r = await acme.admin("GET", "/api/audit")
  const actions = new Set(r.data.events.map((e) => e.action))
  for (const a of [
    "document.created", "document.submitted", "document.issued", "document.pdf_ready", "document.pdf_failed", "document.pdf_retried",
    "document.revoked", "document.superseded", "document.verified", "user.created", "template.created", "organization.verified",
  ]) {
    assert.ok(actions.has(a), `missing ${a}`)
  }
  const pdfReady = r.data.events.find((e) => e.action === "document.pdf_ready")
  assert.equal(pdfReady.userName, "System")
  const staff = r.data.events.find((e) => e.action === "organization.verified")
  assert.equal(staff.userName, "Test Staff (platform staff)")
  assert.equal((await acme.issuer("GET", "/api/audit")).status, 403)
})

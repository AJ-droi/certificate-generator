// Company verification: requesting it, proving the domain, staff approval, and
// what partners see for documents from unverified or suspended companies.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const h = require("../helpers")
const orgs = require("../../src/services/org.service")
const { repo } = require("../../src/config/database")

let acme
let other
let otherDoc
const anon = h.client()

before(async () => {
  await h.startApp()
  acme = await h.createCompany({ name: "Acme Inspections", domain: "acme.test", verified: false })
  other = await h.createCompany({ name: "Other Co", domain: "other.test", verified: false, requireSeparateApprover: false })
})
after(() => h.stopApp())

test("company verification: details, DNS proof, staff approval, name lock", async () => {
  assert.equal((await acme.issuer("POST", "/api/org/verification", {})).status, 403)
  const details = { legalName: "Acme Inspections Limited", registrationNumber: "RC 123456", registrationCountry: "ng", domain: "https://www.acme.test/about" }
  assert.equal((await acme.admin("POST", "/api/org/verification", { ...details, domain: "localhost" })).status, 400)
  assert.equal((await acme.admin("POST", "/api/org/verification", { ...details, registrationCountry: "Nigeria" })).status, 400)
  const r = await acme.admin("POST", "/api/org/verification", details)
  assert.equal(r.status, 200, JSON.stringify(r.data))
  const v = r.data.organization.verification
  assert.equal(v.status, "pending")
  assert.equal(v.domain, "acme.test")
  assert.equal(v.registrationCountry, "NG")
  assert.equal(v.dnsRecord.name, "_docverify.acme.test")

  // Staff can't verify until the domain is proven (or they vouch for it)
  await assert.rejects(orgs.verifyOrganization(acme.slug, { by: "Test Staff" }), /DNS/)
  await assert.rejects(orgs.verifyOrganization(acme.slug, {}), /who is doing this/)

  assert.equal((await acme.admin("POST", "/api/org/verification/check-domain", {})).data.found, false)
  h.txtRecords.set(v.dnsRecord.name, "docverify=wrong-token")
  assert.equal((await acme.admin("POST", "/api/org/verification/check-domain", {})).data.found, false)
  h.txtRecords.set(v.dnsRecord.name, v.dnsRecord.value)
  const hit = await acme.admin("POST", "/api/org/verification/check-domain", {})
  assert.equal(hit.data.found, true)
  assert.equal(hit.data.organization.verification.domainVerified, true)

  const org = await orgs.verifyOrganization(acme.slug, { by: "Test Staff" })
  assert.equal(org.verificationStatus, "verified")
  assert.equal((await acme.admin("GET", "/api/auth/me")).data.organization.verification.status, "verified")

  // Verified details and the company name are locked
  assert.equal((await acme.admin("POST", "/api/org/verification", details)).status, 409)
  assert.equal((await acme.admin("PATCH", "/api/org", { name: "Shell Nigeria" })).status, 409)
  assert.equal((await acme.admin("PATCH", "/api/org", { name: "Acme Inspections" })).status, 200)
})

test("unverified companies can't issue", async () => {
  const t = await other.admin("POST", "/api/templates", { name: "Report", html: h.HTML, schema: h.SCHEMA })
  const d = (await other.admin("POST", "/api/documents", { templateId: t.data.template.id, data: h.DATA })).data.document
  const blocked = await other.admin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(blocked.status, 403)
  assert.match(blocked.data.message, /verified/)
  await orgs.verifyOrganization(other.slug, { by: "Test Staff", legalName: "Other Co Ltd", registrationNumber: "RC 9", registrationCountry: "NG", domain: "other.test", trustDomain: true })
  const issued = await other.admin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200)
  otherDoc = issued.data.document
  await h.settle()
})

test("a company can't pose as a verified one", async () => {
  const fake = h.client()
  const r = await fake("POST", "/api/auth/signup", { orgName: "ACME Inspections Ltd.", name: "Mallory", email: "mallory@gmail.test", password: "mallory-pass-1" })
  assert.equal(r.status, 201)
  const slug = r.data.organization.slug
  assert.notEqual(slug, acme.slug)
  // Acme's domain is taken
  const taken = await fake("POST", "/api/org/verification", { legalName: "Acme Inspections Limited", registrationNumber: "RC 999", registrationCountry: "NG", domain: "acme.test" })
  assert.equal(taken.status, 409)
  await assert.rejects(
    orgs.verifyOrganization(slug, { by: "Test Staff", legalName: "X", registrationNumber: "1", registrationCountry: "NG", domain: "acme.test", trustDomain: true }),
    /already verified/,
  )
  // Staff are warned the name looks like a verified company
  const similar = await orgs.similarOrganizations(await repo("Organization").findOne({ where: { slug } }))
  assert.deepEqual(similar.map((o) => o.slug), [acme.slug])
  // Rejected: the company sees why
  await orgs.rejectOrganization(slug, { by: "Test Staff", reason: "Registration number doesn't match the name" })
  const me = await fake("GET", "/api/auth/me")
  assert.equal(me.data.organization.verification.status, "rejected")
  assert.match(me.data.organization.verification.note, /doesn't match/)
})

test("documents from unverified or suspended issuers aren't shown as valid", async () => {
  assert.equal((await anon("GET", `/api/public/verify/${otherDoc.publicId}`)).data.verdict, "valid")

  await h.db.query("UPDATE organizations SET verification_status = 'unverified' WHERE slug = $1", [other.slug])
  assert.equal((await anon("GET", `/api/public/verify/${otherDoc.publicId}`)).data.verdict, "issuer_unverified")
  assert.match((await anon("GET", `/v/${otherDoc.publicId}`)).data, /Issuer not verified/)
  // Only verified companies can be suspended
  await assert.rejects(orgs.suspendOrganization(other.slug, { by: "Test Staff", reason: "x" }), /Only verified/)

  await h.db.query("UPDATE organizations SET verification_status = 'verified' WHERE slug = $1", [other.slug])
  await orgs.suspendOrganization(other.slug, { by: "Test Staff", reason: "Impersonating another company" })
  const v = await anon("GET", `/api/public/verify/${otherDoc.publicId}`)
  assert.equal(v.data.verdict, "issuer_suspended")
  assert.equal(v.data.issuer.verified, null)
  assert.match((await anon("GET", `/v/${otherDoc.publicId}`)).data, /Issuer suspended/)
  // Suspended companies can't issue
  const t = (await other.admin("GET", "/api/templates")).data.templates[0]
  const d = (await other.admin("POST", "/api/documents", { templateId: t.id, data: h.DATA })).data.document
  const blocked = await other.admin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(blocked.status, 403)
  assert.match(blocked.data.message, /suspended/)
})

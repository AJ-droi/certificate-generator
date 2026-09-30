// The platform staff dashboard (/platform): separate accounts with an
// authenticator app, the review queue, and verification decisions.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const h = require("../helpers")
const totp = require("../../src/lib/totp")
const platformService = require("../../src/services/platform.service")

const staff = h.client()
const anon = h.client()
let acme

before(async () => {
  await h.startApp()
  acme = await h.createCompany({ name: "Acme Inspections", domain: "acme.test" })
})
after(() => h.stopApp())

test("platform staff: separate accounts, new password and authenticator app required", async () => {
  const { temporaryPassword } = await platformService.createStaff({ email: "sam@platform.test", name: "Sam Staff" })
  // Company sessions and company logins don't work here, and vice versa
  assert.equal((await acme.admin("GET", "/api/platform/overview")).status, 401)
  assert.equal((await anon("POST", "/api/platform/auth/login", { email: "admin@acme.test", password: "admin-password-1" })).status, 401)
  assert.equal((await staff("POST", "/api/platform/auth/login", { email: "sam@platform.test", password: "wrong-password" })).status, 401)

  const first = await staff("POST", "/api/platform/auth/login", { email: "sam@platform.test", password: temporaryPassword })
  assert.equal(first.status, 200)
  assert.equal(first.data.setupRequired, true)
  const blocked = await staff("GET", "/api/platform/overview")
  assert.equal(blocked.status, 403)
  assert.equal(blocked.data.details.code, "setup_required")
  assert.equal((await staff("GET", "/api/documents")).status, 401)

  const setup = await staff("POST", "/api/platform/auth/setup/start", {})
  assert.match(setup.data.qr, /^data:image\/png;base64,/)
  const secret = setup.data.secret
  const code = totp.codeAt(secret, totp.currentStep())
  assert.equal((await staff("POST", "/api/platform/auth/setup/finish", { code: "12345", newPassword: "staff-password-123" })).status, 400)
  assert.equal((await staff("POST", "/api/platform/auth/setup/finish", { code, newPassword: "too-short" })).status, 400)
  assert.equal((await staff("POST", "/api/platform/auth/setup/finish", { code, newPassword: "staff-password-123" })).status, 200)
  assert.equal((await staff("GET", "/api/platform/overview")).status, 200)

  // Signing in needs the password and a fresh code; a used code can't be replayed
  const again = h.client()
  const noCode = await again("POST", "/api/platform/auth/login", { email: "sam@platform.test", password: "staff-password-123" })
  assert.equal(noCode.status, 401)
  assert.equal(noCode.data.details.code, "code_required")
  assert.equal((await again("POST", "/api/platform/auth/login", { email: "sam@platform.test", password: "staff-password-123", code })).status, 401)
  const next = totp.codeAt(secret, totp.currentStep() + 1)
  const ok = await again("POST", "/api/platform/auth/login", { email: "sam@platform.test", password: "staff-password-123", code: next })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.setupRequired, false)
  assert.equal((await again("GET", "/api/platform/overview")).status, 200)
  assert.equal((await again("GET", "/api/documents")).status, 401)
})

test("platform staff: review queue, DNS check, verify, suspend, reinstate", async () => {
  const beta = h.client()
  await beta("POST", "/api/auth/signup", { orgName: "Beta Testing", name: "Bo", email: "bo@beta.test", password: "beta-pass-123" })
  await beta("POST", "/api/org/verification", { legalName: "Beta Testing Ltd", registrationNumber: "RC 42", registrationCountry: "NG", domain: "beta.test" })

  const overview = await staff("GET", "/api/platform/overview")
  assert.equal(overview.data.stats.companies.pending, 1)
  assert.equal(overview.data.stats.companies.verified, 1)
  const row = overview.data.pending.find((c) => c.slug === "beta-testing")
  assert.ok(row, "Beta should be waiting for review")
  const verified = await staff("GET", "/api/platform/companies?status=verified")
  assert.deepEqual(verified.data.companies.map((c) => c.slug), [acme.slug])
  assert.equal((await staff("GET", "/api/platform/companies?q=beta")).data.companies.length, 1)
  assert.equal((await staff("GET", "/api/platform/companies?q=%25")).data.companies.length, 0)

  const detail = await staff("GET", `/api/platform/companies/${row.id}`)
  const v = detail.data.organization.verification
  assert.equal(v.status, "pending")
  assert.deepEqual(detail.data.warnings.adminsOffDomain, [])
  assert.equal(detail.data.users[0].email, "bo@beta.test")

  h.txtRecords.set(v.dnsRecord.name, v.dnsRecord.value)
  assert.equal((await staff("POST", `/api/platform/companies/${row.id}/check-dns`, {})).data.found, true)

  // Staff must confirm they checked the registry
  assert.equal((await staff("POST", `/api/platform/companies/${row.id}/verify`, {})).status, 400)
  const ok = await staff("POST", `/api/platform/companies/${row.id}/verify`, { registryChecked: true })
  assert.equal(ok.status, 200, JSON.stringify(ok.data))
  assert.equal(ok.data.organization.verification.status, "verified")
  assert.equal(ok.data.organization.verifiedBy, "Sam Staff")

  assert.equal((await staff("POST", `/api/platform/companies/${row.id}/reject`, { reason: "x" })).status, 409)
  assert.equal((await staff("POST", `/api/platform/companies/${row.id}/suspend`, {})).status, 400)
  const suspended = await staff("POST", `/api/platform/companies/${row.id}/suspend`, { reason: "Checking suspension" })
  assert.equal(suspended.data.organization.verification.status, "suspended")
  const back = await staff("POST", `/api/platform/companies/${row.id}/verify`, { registryChecked: true })
  assert.equal(back.data.organization.verification.status, "verified")

  // Staff actions are logged under the staff member's name, on both sides
  const activity = await staff("GET", "/api/platform/activity")
  const mine = activity.data.events.filter((e) => e.who === "Sam Staff").map((e) => e.action)
  for (const a of ["platform.login", "platform.mfa_enabled", "organization.domain_verified", "organization.verified", "organization.suspended", "organization.reinstated"]) {
    assert.ok(mine.includes(a), `missing ${a}`)
  }
  const companyLog = await beta("GET", "/api/audit")
  assert.ok(companyLog.data.events.some((e) => e.userName === "Sam Staff (platform staff)"))

  // Disabling a staff account signs it out
  await platformService.setStaffActive("sam@platform.test", false)
  assert.equal((await staff("GET", "/api/platform/overview")).status, 401)
})

test("the staff dashboard can be limited to certain IP addresses", async () => {
  process.env.PLATFORM_ALLOWED_IPS = "203.0.113.7"
  try {
    assert.equal((await anon("GET", "/platform")).status, 404)
    assert.equal((await anon("POST", "/api/platform/auth/login", {})).status, 404)
  } finally {
    delete process.env.PLATFORM_ALLOWED_IPS
  }
  assert.equal((await anon("GET", "/platform")).status, 200)
})

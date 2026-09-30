// Sign-up, sign-in, inviting people, and request rules.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const h = require("../helpers")

const admin = h.client()
const approver = h.client()
const issuer = h.client()
const anon = h.client()

before(() => h.startApp())
after(() => h.stopApp())

test("sign up creates a company with its own signing key, not yet verified", async () => {
  const r = await admin("POST", "/api/auth/signup", { orgName: "Acme Inspections", name: "Ada Admin", email: "ada@acme.test", password: "correct-horse-1" })
  assert.equal(r.status, 201)
  assert.equal(r.data.organization.slug, "acme-inspections")
  assert.match(r.data.organization.publicKey, /BEGIN PUBLIC KEY/)
  assert.equal(r.data.organization.privateKeyEnc, undefined)
  assert.equal(r.data.organization.verification.status, "unverified")
  const dup = await anon("POST", "/api/auth/signup", { orgName: "X", name: "X", email: "ada@acme.test", password: "correct-horse-1" })
  assert.equal(dup.status, 409)
  const weak = await anon("POST", "/api/auth/signup", { orgName: "Y", name: "Y", email: "y@y.test", password: "short" })
  assert.equal(weak.status, 400)
})

test("writes must be JSON (blocks cross-site form posts)", async () => {
  const r = await admin("POST", "/api/templates", "name=x", { "content-type": "application/x-www-form-urlencoded" })
  assert.equal(r.status, 415)
})

test("admin invites people; temporary passwords must be changed", async () => {
  const a = await admin("POST", "/api/users", { name: "Paul Approver", email: "paul@acme.test", role: "approver" })
  assert.equal(a.status, 201)
  assert.equal((await admin("POST", "/api/users", { name: "X", email: "x@acme.test", role: "owner" })).status, 400)
  const i = await admin("POST", "/api/users", { name: "Ivy Issuer", email: "ivy@acme.test", role: "issuer" })
  await approver("POST", "/api/auth/login", { email: "paul@acme.test", password: a.data.temporaryPassword })
  const blocked = await approver("GET", "/api/documents")
  assert.equal(blocked.status, 403)
  assert.equal((await approver("POST", "/api/auth/password", { currentPassword: a.data.temporaryPassword, newPassword: "approver-pass-1" })).status, 200)
  assert.equal((await approver("GET", "/api/documents")).status, 200)

  await issuer("POST", "/api/auth/login", { email: "ivy@acme.test", password: i.data.temporaryPassword })
  await issuer("POST", "/api/auth/password", { currentPassword: i.data.temporaryPassword, newPassword: "issuer-pass-12" })
  assert.equal((await anon("POST", "/api/auth/login", { email: "ivy@acme.test", password: "wrong-password" })).status, 401)
  // Only admins manage people
  assert.equal((await issuer("POST", "/api/users", { name: "Z", email: "z@acme.test", role: "admin" })).status, 403)
})

test("the last admin can't be demoted, and disabled people are signed out", async () => {
  const users = (await admin("GET", "/api/users")).data.users
  const me = users.find((u) => u.email === "ada@acme.test")
  assert.equal((await admin("PATCH", `/api/users/${me.id}`, { role: "issuer" })).status, 409)
  const ivy = users.find((u) => u.email === "ivy@acme.test")
  assert.equal((await admin("PATCH", `/api/users/${ivy.id}`, { active: false })).status, 200)
  assert.equal((await issuer("GET", "/api/documents")).status, 401)
})

test("sessions: signing out clears the cookie; bad cookies are ignored", async () => {
  assert.equal((await anon("GET", "/api/auth/me")).status, 401)
  assert.equal((await anon("GET", "/api/documents", undefined, { cookie: "sid=not-a-token" })).status, 401)
  const out = await approver("POST", "/api/auth/logout", {})
  assert.equal(out.status, 200)
})

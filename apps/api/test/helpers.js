// Shared set-up for the end-to-end tests: a real Postgres database (WIPED at the
// start of every test file), the app on a random port, and small HTTP clients
// that keep their session cookie. Test files run one at a time.
require("reflect-metadata")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

process.env.NODE_ENV = "test"
// Tests wipe their database, so they never use the app's database from .env
// (DATABASE_URL may be your real Neon database): they use TEST_DATABASE_URL,
// by default the Docker Compose Postgres (npm run db:up).
const APP_DATABASE_URL = process.env.DATABASE_URL || ""
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5433/certificate_generator_test"
for (const k of ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSL"]) delete process.env[k]
process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cg-test-"))
// Never touch the storage configured in .env (it may be a real bucket): tests use
// the temporary folder above, except storage-s3.test.js, which sets CG_TEST_S3.
if (process.env.CG_TEST_S3 !== "1") {
  process.env.STORAGE_DRIVER = "local"
  for (const k of ["S3_BUCKET", "S3_ENDPOINT", "S3_PREFIX", "AWS_ENDPOINT_URL_S3"]) delete process.env[k]
}
process.env.AUTH_RATE_LIMIT = "1000"
process.env.VERIFY_RATE_LIMIT = "1000"
process.env.PLATFORM_AUTH_RATE_LIMIT = "1000"
if (!process.env.APP_SECRET || process.env.APP_SECRET.length < 32) process.env.APP_SECRET = crypto.randomBytes(48).toString("base64")

const { createApp } = require("../src/app")
const { AppDataSource } = require("../src/config/database")
const { runMigrations } = require("../src/lib/migrations")
const { connectRedis, closeRedis, getRedis } = require("../src/lib/redis")
const { closeBrowser } = require("../src/services/pdf.service")
const { runUntilIdle } = require("../src/services/jobs.service")
const orgs = require("../src/services/org.service")

const TABLES = ["organizations", "users", "templates", "template_versions", "documents", "audit_events", "platform_admins", "jobs"]

// DNS answers for the company domain check, keyed by record name.
const txtRecords = new Map()
orgs.dnsLookup.resolveTxt = async (name) => {
  if (!txtRecords.has(name)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" })
  return [[txtRecords.get(name)]]
}

let server
let base = ""

async function startApp({ port = 0 } = {}) {
  const target = process.env.DATABASE_URL
  const name = decodeURIComponent(new URL(target).pathname.slice(1))
  if (!/test/i.test(name) || target === APP_DATABASE_URL) {
    throw new Error("Refusing to run: tests wipe their database. Set TEST_DATABASE_URL to a separate database with 'test' in its name.")
  }
  await runMigrations()
  await AppDataSource.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`)
  await connectRedis()
  const redis = getRedis()
  if (redis) await redis.flushDb()
  server = createApp().listen(port, "127.0.0.1")
  await new Promise((resolve) => server.once("listening", resolve))
  base = `http://127.0.0.1:${server.address().port}`
}

async function stopApp() {
  await new Promise((resolve) => server.close(resolve))
  await closeBrowser()
  await closeRedis()
  await AppDataSource.destroy()
}

// Minimal cookie-aware HTTP client: client()(method, url, body?, headers?).
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
      body: body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
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

// Makes the official PDFs (and any other queued jobs) now.
const settle = () => runUntilIdle()

// A company whose admin has invited an approver and an issuer (both have set
// their own passwords). Verified by platform staff unless `verified: false`.
async function createCompany({ name, domain, verified = true, requireSeparateApprover = true }) {
  const admin = client()
  const approver = client()
  const issuer = client()
  const r = await admin("POST", "/api/auth/signup", { orgName: name, name: "Ada Admin", email: `admin@${domain}`, password: "admin-password-1" })
  assert.equal(r.status, 201, JSON.stringify(r.data))
  const slug = r.data.organization.slug
  for (const [c, role, person] of [[approver, "approver", "Paul Approver"], [issuer, "issuer", "Ivy Issuer"]]) {
    const invited = await admin("POST", "/api/users", { name: person, email: `${role}@${domain}`, role })
    assert.equal(invited.status, 201)
    await c("POST", "/api/auth/login", { email: `${role}@${domain}`, password: invited.data.temporaryPassword })
    const changed = await c("POST", "/api/auth/password", { currentPassword: invited.data.temporaryPassword, newPassword: `${role}-password-1` })
    assert.equal(changed.status, 200)
  }
  if (!requireSeparateApprover) await admin("PATCH", "/api/org", { requireSeparateApprover: false })
  if (verified) {
    await orgs.verifyOrganization(slug, {
      by: "Test Staff",
      legalName: `${name} Limited`,
      registrationNumber: "RC 123456",
      registrationCountry: "NG",
      domain,
      trustDomain: true,
    })
  }
  return { slug, id: r.data.organization.id, admin, approver, issuer }
}

// ---- Fixtures ---------------------------------------------------------------------------

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

// Draft -> submitted -> approved by someone else. Returns the issued document.
async function issueDocument(company, templateId, data = DATA) {
  const d = await company.issuer("POST", "/api/documents", { templateId, data })
  assert.equal(d.status, 201, JSON.stringify(d.data))
  assert.equal((await company.issuer("POST", `/api/documents/${d.data.document.id}/submit`, {})).status, 200)
  const issued = await company.approver("POST", `/api/documents/${d.data.document.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  return issued.data.document
}

async function uploadPdf(call, buffer) {
  const res = await fetch(base + "/api/templates/pdf-source", {
    method: "POST",
    headers: { "content-type": "application/pdf", cookie: call.cookie },
    body: buffer,
  })
  return { status: res.status, data: await res.json() }
}

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

module.exports = {
  startApp,
  stopApp,
  client,
  settle,
  createCompany,
  issueDocument,
  uploadPdf,
  pdfText,
  txtRecords,
  SCHEMA,
  HTML,
  DATA,
  db: AppDataSource,
  baseUrl: () => base,
}

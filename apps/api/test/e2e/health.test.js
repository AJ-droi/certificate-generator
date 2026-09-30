// Health checks, request IDs and the error response.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const h = require("../helpers")

const anon = h.client()
before(() => h.startApp())
after(() => h.stopApp())

test("/healthz says the process is up", async () => {
  const r = await anon("GET", "/healthz")
  assert.equal(r.status, 200)
  assert.deepEqual(r.data, { ok: true })
})

test("/readyz checks the database, migrations, storage, Redis and the job queue", async () => {
  const r = await anon("GET", "/readyz")
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.ok, true)
  for (const k of ["database", "migrations", "storage", "redis", "jobs"]) assert.equal(r.data.checks[k].ok, true, k)
  assert.equal(r.data.checks.storage.driver, "local")
  assert.equal(typeof r.data.checks.jobs.queued, "number")
})

test("/readyz fails when storage is unusable", async () => {
  const dir = process.env.STORAGE_DIR
  process.env.STORAGE_DIR = "/dev/null/not-a-dir"
  try {
    const r = await anon("GET", "/readyz")
    assert.equal(r.status, 503)
    assert.equal(r.data.checks.storage.ok, false)
  } finally {
    process.env.STORAGE_DIR = dir
  }
})

test("every response has a request ID, and a valid incoming one is kept", async () => {
  const r = await anon("GET", "/healthz")
  assert.match(r.headers.get("x-request-id"), /^[0-9a-f-]{36}$/)
  const mine = await anon("GET", "/healthz", undefined, { "x-request-id": "trace-12345678" })
  assert.equal(mine.headers.get("x-request-id"), "trace-12345678")
  const bad = await anon("GET", "/healthz", undefined, { "x-request-id": "<script>" })
  assert.notEqual(bad.headers.get("x-request-id"), "<script>")
})

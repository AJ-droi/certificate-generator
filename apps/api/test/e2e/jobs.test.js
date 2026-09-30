// The Postgres job queue: each job runs once even with several workers,
// failures are retried later, and the last failure is reported.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const h = require("../helpers")
const jobs = require("../../src/services/jobs.service")

before(() => h.startApp())
after(() => h.stopApp())

test("several workers never run the same job twice", async () => {
  const seen = []
  jobs.registerJob("test.record", {
    async run({ n }) {
      await new Promise((r) => setTimeout(r, 5))
      seen.push(n)
    },
  })
  for (let n = 0; n < 30; n++) await jobs.enqueue(null, "test.record", { n })
  const counts = await Promise.all([jobs.runUntilIdle({ workerId: "a" }), jobs.runUntilIdle({ workerId: "b" }), jobs.runUntilIdle({ workerId: "c" })])
  assert.equal(counts.reduce((a, b) => a + b, 0), 30)
  assert.equal(new Set(seen).size, 30)
  assert.equal(seen.length, 30)
  const [row] = await h.db.query("SELECT count(*)::int AS n FROM jobs WHERE type = 'test.record' AND status = 'done'")
  assert.equal(row.n, 30)
})

test("a failing job is retried later, then marked failed and reported once", async () => {
  let runs = 0
  const failures = []
  jobs.registerJob("test.flaky", {
    async run() {
      runs++
      throw new Error("boom")
    },
    async onFailed(payload, err) {
      failures.push([payload.id, err.message])
    },
  })
  const job = await jobs.enqueue(null, "test.flaky", { id: "x" }, { maxAttempts: 2 })
  await jobs.runUntilIdle()
  let [row] = await h.db.query("SELECT status, attempts, run_at > now() AS later FROM jobs WHERE id = $1", [job.id])
  assert.deepEqual([row.status, row.attempts, row.later], ["queued", 1, true])
  // Not due yet: nothing runs.
  assert.equal(await jobs.runUntilIdle(), 0)
  await h.db.query("UPDATE jobs SET run_at = now() WHERE id = $1", [job.id])
  await jobs.runUntilIdle()
  ;[row] = await h.db.query("SELECT status, attempts, last_error FROM jobs WHERE id = $1", [job.id])
  assert.deepEqual([row.status, row.attempts], ["failed", 2])
  assert.match(row.last_error, /boom/)
  assert.equal(runs, 2)
  assert.deepEqual(failures, [["x", "boom"]])
})

test("an unknown job type fails instead of looping", async () => {
  const job = await jobs.enqueue(null, "test.nobody-handles-this", {}, { maxAttempts: 1 })
  await jobs.runUntilIdle()
  const [row] = await h.db.query("SELECT status, last_error FROM jobs WHERE id = $1", [job.id])
  assert.equal(row.status, "failed")
  assert.match(row.last_error, /No handler/)
})

test("the background worker picks up new jobs and stops cleanly", async () => {
  let done = 0
  jobs.registerJob("test.count", { run: async () => void done++ })
  const worker = new jobs.Worker({ concurrency: 2, pollMs: 50 })
  worker.start()
  for (let i = 0; i < 5; i++) await jobs.enqueue(null, "test.count")
  for (let i = 0; i < 100 && done < 5; i++) await new Promise((r) => setTimeout(r, 20))
  await worker.stop()
  assert.equal(done, 5)
  const stats = await jobs.queueStats()
  assert.equal(stats.queued, 0)
  assert.equal(stats.running, 0)
})

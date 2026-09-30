// A small job queue stored in Postgres (the "jobs" table).
//
// - enqueue() takes the transaction's entity manager, so a job is added in the
//   same transaction as the change that needs it: both happen, or neither.
// - Workers claim jobs with FOR UPDATE SKIP LOCKED, so any number of servers can
//   run workers without two picking up the same job.
// - Failed jobs are retried with growing delays, then marked failed. Jobs whose
//   worker died mid-run are picked up again after a timeout.
const os = require("os")
const crypto = require("crypto")
const { AppDataSource } = require("../config/database")
const { config } = require("../config")
const { logger } = require("../lib/logger")
const { captureError } = require("../lib/monitoring")

const handlers = new Map()
const STALE_AFTER = "10 minutes"

// handler: { run(payload, job), onFailed?(payload, err) } — onFailed runs once, after the last attempt.
function registerJob(type, handler) {
  handlers.set(type, handler)
}

async function enqueue(manager, type, payload = {}, { maxAttempts = 5 } = {}) {
  const r = manager || AppDataSource.manager
  const job = await r.getRepository("Job").save({ type, payload, maxAttempts })
  return job
}

async function claimNext(workerId) {
  const rows = await AppDataSource.query(
    `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1, attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now()
       ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     RETURNING id, type, payload, attempts, max_attempts AS "maxAttempts"`,
    [workerId],
  )
  // For UPDATE … RETURNING, TypeORM gives [rows, affectedCount].
  const claimed = Array.isArray(rows[0]) ? rows[0] : rows
  return claimed[0] || null
}

// 10s, 40s, 90s, 160s… capped at 10 minutes.
const backoffSeconds = (attempts) => Math.min(600, 10 * attempts * attempts)

async function finish(job, err) {
  if (!err) {
    await AppDataSource.query(`UPDATE jobs SET status = 'done', locked_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`, [job.id])
    return
  }
  const final = job.attempts >= job.maxAttempts
  const message = String((err && err.stack) || err).slice(0, 4000)
  await AppDataSource.query(
    `UPDATE jobs SET status = $2, locked_at = NULL, last_error = $3, run_at = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
    [job.id, final ? "failed" : "queued", message, String(backoffSeconds(job.attempts))],
  )
  logger.error({ err, jobId: job.id, type: job.type, attempt: job.attempts, final }, "Job failed")
  captureError(err, { jobId: job.id, type: job.type, attempt: job.attempts })
  if (final) {
    const h = handlers.get(job.type)
    if (h && h.onFailed) await h.onFailed(job.payload, err).catch((e) => logger.error({ err: e }, "Job onFailed handler failed"))
  }
}

async function runOne(job) {
  const h = handlers.get(job.type)
  const started = Date.now()
  try {
    if (!h) throw new Error(`No handler for job type "${job.type}"`)
    await h.run(job.payload, job)
    await finish(job)
    logger.info({ jobId: job.id, type: job.type, ms: Date.now() - started }, "Job done")
  } catch (err) {
    await finish(job, err)
  }
}

// Jobs whose worker stopped mid-run (crash, deploy) go back in the queue.
async function requeueStale() {
  await AppDataSource.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = now() WHERE status = 'running' AND locked_at < now() - interval '${STALE_AFTER}'`,
  )
}

// Finished jobs are kept a week for troubleshooting.
async function cleanup() {
  await AppDataSource.query(`DELETE FROM jobs WHERE status = 'done' AND updated_at < now() - interval '7 days'`)
}

class Worker {
  constructor({ concurrency = config.worker.concurrency, pollMs = config.worker.pollMs } = {}) {
    this.id = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`
    this.concurrency = concurrency
    this.pollMs = pollMs
    this.running = new Set()
    this.stopped = true
    this.timer = null
    this.lastMaintenance = 0
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    logger.info({ worker: this.id, concurrency: this.concurrency }, "Job worker started")
    this.tick()
  }

  async tick() {
    if (this.stopped) return
    try {
      if (Date.now() - this.lastMaintenance > 60_000) {
        this.lastMaintenance = Date.now()
        await requeueStale()
        await cleanup()
      }
      while (!this.stopped && this.running.size < this.concurrency) {
        const job = await claimNext(this.id)
        if (!job) break
        const p = runOne(job).finally(() => {
          this.running.delete(p)
          // A slot freed up: look for more work straight away.
          if (!this.stopped) setImmediate(() => this.tick())
        })
        this.running.add(p)
      }
    } catch (err) {
      logger.error({ err }, "Job worker error")
    }
    if (!this.stopped) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.tick(), this.pollMs)
    }
  }

  // Stops taking new jobs and waits for the ones in progress.
  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await Promise.allSettled([...this.running])
    logger.info({ worker: this.id }, "Job worker stopped")
  }
}

// Runs queued jobs in this process until none are due. For scripts and tests.
async function runUntilIdle({ workerId = `inline:${process.pid}` } = {}) {
  let count = 0
  for (;;) {
    const job = await claimNext(workerId)
    if (!job) return count
    await runOne(job)
    count++
  }
}

async function queueStats() {
  const [row] = await AppDataSource.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            extract(epoch FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now()))::int AS "oldestQueuedSeconds"
     FROM jobs`,
  )
  return row
}

module.exports = { registerJob, enqueue, Worker, runUntilIdle, queueStats }

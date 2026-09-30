// Health checks for load balancers and orchestrators.
//   /healthz  liveness: the process is up (never touches dependencies)
//   /readyz   readiness: database, migrations, file storage and Redis all work.
//             Returns 503 until they do, so traffic isn't sent to a broken server.
const express = require("express")
const { AppDataSource, pendingMigrations } = require("../config/database")
const { checkStorage, storageDriverName } = require("../services/storage.service")
const { queueStats } = require("../services/jobs.service")
const { getRedis } = require("../lib/redis")
const { config } = require("../config")

const router = express.Router()

// Hosted storage far from the server can take seconds to answer; READY_CHECK_TIMEOUT_MS tunes this.
const withTimeout = (p, ms = config.readyCheckTimeoutMs) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))])

async function check(name, fn) {
  const started = Date.now()
  try {
    const detail = await withTimeout(fn())
    return [name, { ok: true, ms: Date.now() - started, ...(detail || {}) }]
  } catch (err) {
    return [name, { ok: false, ms: Date.now() - started, error: err.message }]
  }
}

router.get("/healthz", (req, res) => res.json({ ok: true }))

router.get("/readyz", async (req, res) => {
  const checks = Object.fromEntries(
    await Promise.all([
      check("database", async () => {
        await AppDataSource.query("SELECT 1")
      }),
      check("migrations", async () => {
        const pending = await pendingMigrations()
        if (pending.length) throw new Error(`pending: ${pending.join(", ")}`)
      }),
      check("storage", async () => {
        await checkStorage()
        return { driver: storageDriverName() }
      }),
      check("redis", async () => {
        if (!config.redisUrl) return { configured: false }
        const redis = getRedis()
        if (!redis) throw new Error("not connected")
        await redis.ping()
      }),
      // Informational: a growing backlog means workers can't keep up.
      check("jobs", async () => queueStats()),
    ]),
  )
  const ok = ["database", "migrations", "storage", "redis"].every((k) => checks[k].ok)
  res.status(ok ? 200 : 503).setHeader("Cache-Control", "no-store").json({ ok, checks })
})

module.exports = router

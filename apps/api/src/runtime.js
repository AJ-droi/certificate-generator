// Start-up and shutdown shared by the web server (server.js) and the standalone
// worker (worker.js): check settings, connect to everything, stop cleanly.
const { config, assertConfig } = require("./config")
const { logger } = require("./lib/logger")
const { initMonitoring, captureError, flushMonitoring } = require("./lib/monitoring")
const { AppDataSource, initializeDatabase, pendingMigrations } = require("./config/database")
const { runMigrations } = require("./lib/migrations")
const { connectRedis, closeRedis } = require("./lib/redis")
const { closeBrowser } = require("./services/pdf.service")
// Registers the background job handlers.
require("./services/document.service")

async function startRuntime() {
  assertConfig()
  initMonitoring()
  await initializeDatabase()
  if (config.migrateOnStart) {
    await runMigrations()
  } else {
    const pending = await pendingMigrations()
    if (pending.length) {
      throw new Error(`The database needs migrating (${pending.join(", ")}). Run: npm run db:migrate`)
    }
  }
  await connectRedis()
}

// Runs `steps` in order when the process is asked to stop, then exits.
function onShutdown(steps) {
  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, "Shutting down")
    const force = setTimeout(() => process.exit(1), 25_000).unref()
    for (const step of [...steps, closeBrowser, closeRedis, () => AppDataSource.isInitialized && AppDataSource.destroy(), flushMonitoring]) {
      try {
        await step()
      } catch (err) {
        logger.error({ err }, "Error while shutting down")
      }
    }
    clearTimeout(force)
    process.exit(0)
  }
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "Unhandled promise rejection")
    captureError(err)
  })
}

module.exports = { startRuntime, onShutdown, config, logger }

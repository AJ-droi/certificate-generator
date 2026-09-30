const { startRuntime, onShutdown, config, logger } = require("./src/runtime")
const { createApp } = require("./src/app")
const { Worker } = require("./src/services/jobs.service")

async function start() {
  await startRuntime()
  const server = createApp().listen(config.port, () => logger.info({ port: config.port }, `Server running on http://localhost:${config.port}`))
  // Slightly longer than typical load-balancer idle timeouts, so they close first.
  server.keepAliveTimeout = 65_000
  const worker = config.worker.enabled ? new Worker() : null
  if (worker) worker.start()
  onShutdown([
    () => new Promise((resolve) => server.close(() => resolve())),
    () => worker && worker.stop(),
  ])
}

start().catch((err) => {
  logger.fatal({ err }, err.code === "CONFIG_INVALID" ? err.message : "Failed to start")
  process.exit(1)
})

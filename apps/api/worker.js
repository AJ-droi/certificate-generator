// Background worker on its own (makes official PDFs). Use it to run PDF work on
// separate machines: set RUN_WORKER=false on the web servers and run `npm run worker`.
const { startRuntime, onShutdown, logger } = require("./src/runtime")
const { Worker } = require("./src/services/jobs.service")

async function start() {
  await startRuntime()
  const worker = new Worker()
  worker.start()
  onShutdown([() => worker.stop()])
}

start().catch((err) => {
  logger.fatal({ err }, err.code === "CONFIG_INVALID" ? err.message : "Worker failed to start")
  process.exit(1)
})

// Error tracking with Sentry, when SENTRY_DSN is set. Everything here is a no-op otherwise.
const { config } = require("../config")
const { logger } = require("./logger")

let Sentry = null

function initMonitoring() {
  if (!config.sentryDsn || Sentry) return
  Sentry = require("@sentry/node")
  Sentry.init({
    dsn: config.sentryDsn,
    environment: config.nodeEnv,
    // Errors only; no performance tracing, and no request bodies or cookies.
    tracesSampleRate: 0,
    sendDefaultPii: false,
  })
  logger.info("Error tracking enabled (Sentry)")
}

// `context`: small, non-sensitive facts that help debugging (ids, not data).
function captureError(err, context = {}) {
  if (Sentry) Sentry.captureException(err, { extra: context })
}

async function flushMonitoring() {
  if (Sentry) await Sentry.flush(2000).catch(() => {})
}

module.exports = { initMonitoring, captureError, flushMonitoring }

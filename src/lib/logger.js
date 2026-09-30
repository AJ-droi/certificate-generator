// Structured JSON logs (one line per event), ready for any log collector.
// In development, pipe through `npx pino-pretty` for readable output.
const pino = require("pino")
const { config } = require("../config")

const logger = pino({
  level: config.logLevel,
  base: { service: "certificate-generator" },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never write secrets or session cookies to the logs.
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']", "*.password", "*.newPassword", "*.currentPassword", "*.code"],
    censor: "[redacted]",
  },
})

module.exports = { logger }

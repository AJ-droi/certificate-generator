// Rate limiters that count across all servers when Redis is configured.
// The limiter is built on first use, so Redis has been connected by then.
const rateLimit = require("express-rate-limit")
const { getRedis } = require("./redis")

function limiter({ name, windowMs, limit, message }) {
  let instance = null
  const build = () => {
    const redis = getRedis()
    let store
    if (redis) {
      const { RedisStore } = require("rate-limit-redis")
      store = new RedisStore({ prefix: `rl:${name}:`, sendCommand: (...args) => redis.sendCommand(args) })
    }
    return rateLimit({
      windowMs,
      // A function, so tests and config changes apply without rebuilding.
      limit: typeof limit === "function" ? limit : () => limit,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      store,
      message: message ? { message } : undefined,
      // Built on first request on purpose (after Redis connects), not per request.
      validate: { creationStack: false },
    })
  }
  return (req, res, next) => {
    if (!instance) instance = build()
    return instance(req, res, next)
  }
}

module.exports = { limiter }

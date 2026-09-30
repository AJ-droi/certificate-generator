// Optional Redis connection (REDIS_URL). Shared state for running more than one
// server: rate-limit counters and dashboard previews. Without it, both stay in
// this process's memory, which is fine for a single server.
const { config } = require("../config")
const { logger } = require("./logger")

let client = null

async function connectRedis() {
  if (!config.redisUrl || client) return client
  const { createClient } = require("redis")
  client = createClient({ url: config.redisUrl, socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) } })
  client.on("error", (err) => logger.error({ err }, "Redis error"))
  await client.connect()
  logger.info("Connected to Redis")
  return client
}

const getRedis = () => (client && client.isOpen ? client : null)

async function closeRedis() {
  if (client) {
    const c = client
    client = null
    await c.quit().catch(() => {})
  }
}

module.exports = { connectRedis, getRedis, closeRedis }

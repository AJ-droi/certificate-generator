const { createApp } = require("./src/app")
const { initializeDatabase } = require("./src/config/database")
const { appSecret } = require("./src/lib/crypto")
const { closeBrowser } = require("./src/services/pdf.service")

const PORT = Number(process.env.PORT || 3100)

async function start() {
  try {
    appSecret() // fail fast if missing in production
    await initializeDatabase()
    const server = createApp().listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`))
    const shutdown = async () => {
      server.close()
      await closeBrowser()
      process.exit(0)
    }
    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  } catch (error) {
    console.error("Failed to start", error)
    process.exit(1)
  }
}

start()

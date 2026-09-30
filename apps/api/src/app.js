require("reflect-metadata")
const path = require("path")
const fs = require("fs")
const crypto = require("crypto")
const express = require("express")
const cookieParser = require("cookie-parser")
const pinoHttp = require("pino-http")
const { config } = require("./config")
const { logger } = require("./lib/logger")
const healthRoutes = require("./routes/health.routes")
const { loadUser, requireJsonForWrites } = require("./lib/auth")
const { errorHandler } = require("./lib/errors")
const authRoutes = require("./routes/auth.routes")
const apiRoutes = require("./routes/api.routes")
const publicRoutes = require("./routes/public.routes")
const platformRoutes = require("./routes/platform.routes")
const { staffIpAllowlist } = require("./lib/platform-auth")

function createApp() {
  const app = express()
  app.disable("x-powered-by")
  if (config.trustProxy) app.set("trust proxy", config.trustProxy)

  // One JSON log line per request, with a request ID (also sent back as
  // X-Request-Id) that ties together everything logged while handling it.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"]
        const id = typeof incoming === "string" && /^[A-Za-z0-9._-]{8,100}$/.test(incoming) ? incoming : crypto.randomUUID()
        res.setHeader("X-Request-Id", id)
        return id
      },
      autoLogging: { ignore: (req) => req.url.startsWith("/assets/") || req.url.startsWith("/vendor/") || req.url === "/healthz" },
      // 503 is an expected "not ready yet" (e.g. a PDF still being made), not a fault.
      customLogLevel: (req, res, err) =>
        err || (res.statusCode >= 500 && res.statusCode !== 503) ? "error" : res.statusCode >= 400 ? "warn" : "info",
      serializers: {
        // Path only: query strings can carry search terms and codes.
        req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split("?")[0], ip: req.remoteAddress }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  )

  // Security headers for our own pages. Rendered customer documents
  // (/render, /v/:id/document) replace the CSP with a sandboxed one.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "same-origin")
    res.setHeader("X-Frame-Options", "SAMEORIGIN")
    res.setHeader(
      "Content-Security-Policy",
      // 'wasm-unsafe-eval' lets pdf.js decode scanned (JBIG2/JPEG 2000) PDFs; it doesn't allow eval().
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; " +
        "frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    )
    next()
  })

  app.use(express.json({ limit: "5mb" }))
  app.use(cookieParser())
  app.use(loadUser)

  // Styles shared by the verify pages and the dashboards (packages/shared).
  const sharedCss = require.resolve("@doctrust/shared/styles/site.css")
  app.get("/assets/site.css", (req, res) => {
    res.setHeader("Cache-Control", "no-cache")
    res.sendFile(sharedCss)
  })
  // The verify page's script and the icon.
  app.use("/assets", express.static(path.join(__dirname, "..", "public", "assets"), { maxAge: "1h" }))
  // pdf.js, served from this server so the dashboard can show PDFs without a CDN.
  const pdfjs = path.dirname(require.resolve("pdfjs-dist/package.json"))
  for (const dir of ["build", "wasm", "standard_fonts", "cmaps"]) {
    app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(pdfjs, dir), { maxAge: "7d", index: false }))
  }
  app.use("/images", express.static(path.join(__dirname, "..", "public", "images"), { maxAge: "1h" }))
  app.use(healthRoutes)
  // The dashboards (the React app in apps/web, built with `npm run build`):
  // hashed files under /web/assets, pages at /app/… and /platform/…
  const webDist = config.webDist
  app.use("/web/assets", express.static(path.join(webDist, "assets"), { index: false, immutable: true, maxAge: "1y" }))
  const dashboard = (file) => (req, res) => {
    const page = path.join(webDist, file)
    if (!fs.existsSync(page)) {
      return res.status(503).type("text/plain").send("The dashboard isn't built yet. Run `npm run build`, or use `npm run dev` for development.")
    }
    res.setHeader("Cache-Control", "no-cache")
    res.sendFile(page)
  }
  app.get(["/app", "/app/*splat"], dashboard("app.html"))
  // Platform staff dashboard: verifying and monitoring companies.
  app.get(["/platform", "/platform/*splat"], staffIpAllowlist, (req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex")
    next()
  }, dashboard("platform.html"))
  app.use("/api/platform", staffIpAllowlist, requireJsonForWrites, platformRoutes)

  app.use("/api/auth", requireJsonForWrites, authRoutes)
  app.use("/", publicRoutes) // landing, /v/:code, /api/public/*, /render/:token, legacy /report/*
  app.use("/api", requireJsonForWrites, apiRoutes)

  app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }))
  app.use(errorHandler)
  return app
}

module.exports = { createApp }

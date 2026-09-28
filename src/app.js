require("reflect-metadata")
const path = require("path")
const express = require("express")
const cookieParser = require("cookie-parser")
const { loadUser, requireJsonForWrites } = require("./lib/auth")
const { errorHandler } = require("./lib/errors")
const authRoutes = require("./routes/auth.routes")
const apiRoutes = require("./routes/api.routes")
const publicRoutes = require("./routes/public.routes")

function createApp() {
  const app = express()
  app.disable("x-powered-by")
  if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? true : process.env.TRUST_PROXY)

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

  app.use("/assets", express.static(path.join(__dirname, "..", "public", "assets"), { maxAge: "1h" }))
  // pdf.js, served from this server so the dashboard can show PDFs without a CDN.
  const pdfjs = path.dirname(require.resolve("pdfjs-dist/package.json"))
  for (const dir of ["build", "wasm", "standard_fonts", "cmaps"]) {
    app.use(`/vendor/pdfjs/${dir}`, express.static(path.join(pdfjs, dir), { maxAge: "7d", index: false }))
  }
  // pdf-lib in the browser: the PDF editor uses it to build a cleaned copy of a form.
  app.use("/vendor/pdf-lib", express.static(path.join(path.dirname(require.resolve("pdf-lib/package.json")), "dist"), { maxAge: "7d", index: false }))
  app.use("/images", express.static(path.join(__dirname, "..", "public", "images"), { maxAge: "1h" }))
  app.get("/app", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "app.html")))
  app.get("/healthz", (req, res) => res.json({ ok: true }))

  app.use("/api/auth", requireJsonForWrites, authRoutes)
  app.use("/", publicRoutes) // landing, /v/:code, /api/public/*, /render/:token, legacy /report/*
  app.use("/api", requireJsonForWrites, apiRoutes)

  app.use("/api", (req, res) => res.status(404).json({ message: "Not found" }))
  app.use(errorHandler)
  return app
}

module.exports = { createApp }

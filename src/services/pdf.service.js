const puppeteer = require("puppeteer")
const { config } = require("../config")
const { logger } = require("../lib/logger")

// Templates are written by customers, so the headless browser may only load
// inline data and a short list of public CDNs. This stops a template from
// reading local files (file://) or calling internal services.
const allowedHosts = () => new Set(config.renderAllowedHosts)

// At most RENDER_CONCURRENCY Chrome pages at once in this process; the rest wait
// their turn. Stops a burst of previews or PDFs from exhausting memory.
const waiting = []
let active = 0
async function withPage(fn) {
  if (active >= config.render.concurrency) await new Promise((resolve) => waiting.push(resolve))
  active++
  const started = Date.now()
  try {
    const browser = await getBrowser()
    const page = await browser.newPage()
    try {
      return await fn(page)
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    active--
    const next = waiting.shift()
    if (next) next()
    logger.debug({ ms: Date.now() - started, queued: waiting.length }, "chrome page closed")
  }
}

let browserPromise = null

function getBrowser() {
  if (!browserPromise) {
    const args = ["--disable-dev-shm-usage", "--no-first-run", "--no-zygote"]
    if (config.render.noSandbox) args.push("--no-sandbox", "--disable-setuid-sandbox")
    browserPromise = puppeteer
      .launch({
        headless: true,
        args,
        executablePath: config.render.executablePath || undefined,
      })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null
        })
        return browser
      })
      .catch((err) => {
        browserPromise = null
        throw err
      })
  }
  return browserPromise
}

function isAllowed(url, hosts) {
  if (url.startsWith("data:") || url === "about:blank") return true
  try {
    const u = new URL(url)
    return u.protocol === "https:" && hosts.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

async function htmlToPdf(html) {
  const hosts = allowedHosts()
  return withPage(async (page) => {
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (isAllowed(request.url(), hosts)) request.continue()
      else request.abort("blockedbyclient")
    })
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 })
    return Buffer.from(
      await page.pdf({
        format: "A4",
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
        preferCSSPageSize: true,
        printBackground: true,
        timeout: 60000,
      }),
    )
  })
}

// Converts an image the PDF library can't embed directly (WebP, GIF, SVG) into PNG.
async function imageToPng(dataUrl) {
  if (!/^data:image\/(webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(String(dataUrl))) {
    throw new Error("Unsupported image")
  }
  return withPage(async (page) => {
    await page.setRequestInterception(true)
    page.on("request", (r) => (r.url().startsWith("data:") || r.url() === "about:blank" ? r.continue() : r.abort()))
    await page.setJavaScriptEnabled(false)
    await page.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="${dataUrl}" style="display:block;max-width:1200px;max-height:1200px"></body></html>`, { waitUntil: "load", timeout: 15000 })
    const img = await page.$("#i")
    const box = await img.boundingBox()
    if (!box || box.width < 1 || box.height < 1) throw new Error("Image has no size")
    return Buffer.from(await img.screenshot({ type: "png", omitBackground: true }))
  })
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null)
    browserPromise = null
    if (b) await b.close().catch(() => {})
  }
}

module.exports = { htmlToPdf, imageToPng, closeBrowser, isAllowed }

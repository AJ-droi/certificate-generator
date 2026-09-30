// Showing PDFs with pdf.js (served from this server), and the preview frame.
import { h } from "../lib/dom.js"

export let pdfjsPromise = null
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("/vendor/pdfjs/build/pdf.min.mjs").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs"
      return lib
    })
  }
  return pdfjsPromise
}

export async function openPdf(source) {
  const lib = await loadPdfjs()
  const data = source instanceof ArrayBuffer ? new Uint8Array(source) : source
  return lib.getDocument({
    ...(typeof data === "string" ? { url: data, withCredentials: true } : { data }),
    isEvalSupported: false,
    wasmUrl: "/vendor/pdfjs/wasm/",
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
  }).promise
}

// Draws one page onto a canvas at `scale` CSS pixels per PDF point.
export async function drawPdfPage(pdf, index, scale, canvas) {
  const page = await pdf.getPage(index + 1)
  const viewport = page.getViewport({ scale })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  const ctx = canvas.getContext("2d")
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  await page.render({ canvasContext: ctx, viewport }).promise
  return viewport
}

// Renders every page of a PDF, stacked, fitted to the container's width.
export async function renderPdfPages(container, source) {
  const pdf = await openPdf(source)
  container.replaceChildren()
  const width = Math.max(200, container.clientWidth - 24)
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1)
    const base = page.getViewport({ scale: 1 })
    const canvas = h("canvas", { class: "pdf-canvas" })
    container.append(canvas)
    await drawPdfPage(pdf, i, width / base.width, canvas)
  }
  return pdf.numPages
}

// A preview area that shows either a rendered HTML page (in a sandboxed,
// scaled iframe) or a PDF (drawn with pdf.js).
export const PAGE_PX = 830 // an A4 page is ~794px wide
export function previewFrame(title) {
  const frame = h("iframe", { title, sandbox: "allow-scripts allow-popups", referrerpolicy: "no-referrer" })
  const pdfHost = h("div", { class: "pdf-scroll", hidden: true })
  const box = h("div", { class: "preview-box" }, frame, pdfHost)
  const fit = () => {
    const s = Math.min(1, box.clientWidth / PAGE_PX) || 1
    frame.style.transform = `scale(${s})`
    frame.style.width = `${PAGE_PX}px`
    frame.style.height = `${box.clientHeight / s}px`
  }
  new ResizeObserver(fit).observe(box)
  async function show(result) {
    if (result.kind === "pdf") {
      frame.hidden = true
      frame.removeAttribute("src")
      pdfHost.hidden = false
      pdfHost.replaceChildren(h("p", { class: "loading", style: "padding:16px" }, "Rendering…"))
      const res = await fetch(result.previewUrl, { credentials: "same-origin" })
      if (!res.ok) throw new Error("Preview expired — refresh it")
      await renderPdfPages(pdfHost, await res.arrayBuffer())
    } else {
      pdfHost.hidden = true
      frame.hidden = false
      frame.src = result.previewUrl
    }
  }
  return { box, frame, show }
}

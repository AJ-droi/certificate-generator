// Showing PDFs with pdf.js. The library, its worker, fonts and WebAssembly
// decoders are served by the API from /vendor/pdfjs (no CDN).
/* eslint-disable @typescript-eslint/no-explicit-any */

export type PdfDocument = any

let pdfjs: Promise<any> | null = null
export function loadPdfjs(): Promise<any> {
  if (!pdfjs) {
    const url = "/vendor/pdfjs/build/pdf.min.mjs"
    pdfjs = import(/* @vite-ignore */ url).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/build/pdf.worker.min.mjs"
      return lib
    })
  }
  return pdfjs
}

export async function openPdf(source: string | ArrayBuffer): Promise<PdfDocument> {
  const lib = await loadPdfjs()
  return lib.getDocument({
    ...(typeof source === "string" ? { url: source, withCredentials: true } : { data: new Uint8Array(source) }),
    isEvalSupported: false,
    wasmUrl: "/vendor/pdfjs/wasm/",
    standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    cMapUrl: "/vendor/pdfjs/cmaps/",
    cMapPacked: true,
  }).promise
}

// Draws one page onto a canvas at `scale` CSS pixels per PDF point.
export async function drawPdfPage(pdf: PdfDocument, index: number, scale: number, canvas: HTMLCanvasElement) {
  const page = await pdf.getPage(index + 1)
  const viewport = page.getViewport({ scale })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  const ctx = canvas.getContext("2d")!
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  await page.render({ canvasContext: ctx, viewport }).promise
  return viewport
}

// Renders every page of a PDF, stacked, fitted to the container's width.
export async function renderPdfPages(container: HTMLElement, source: string | ArrayBuffer): Promise<number> {
  const pdf = await openPdf(source)
  container.replaceChildren()
  const width = Math.max(200, container.clientWidth - 24)
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1)
    const base = page.getViewport({ scale: 1 })
    const canvas = document.createElement("canvas")
    canvas.className = "pdf-canvas"
    container.append(canvas)
    await drawPdfPage(pdf, i, width / base.width, canvas)
  }
  return pdf.numPages
}

// Fetches a rendered preview (HTML or PDF) as bytes.
export async function fetchPreviewPdf(previewUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(previewUrl, { credentials: "same-origin" })
  if (!res.ok) throw new Error("Preview expired — refresh it")
  return res.arrayBuffer()
}

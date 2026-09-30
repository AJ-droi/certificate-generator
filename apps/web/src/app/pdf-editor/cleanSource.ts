// Builds a copy of the uploaded form with the erase areas painted out, and
// uploads it as the form documents are printed on. Pages without erase areas
// are copied as they are; pages with them are redrawn as an image (216 dpi),
// so the old text is really gone rather than hidden.
import type { UploadedSource } from "@doctrust/shared"
import { postPdf } from "../../shared/api"
import type { PdfDocument } from "../../shared/pdf"
import type { EraseArea, EditorModel } from "./model"

const K = 3 // 72 dpi × 3 = 216 dpi

export async function buildCleanSource(m: EditorModel, areas: EraseArea[], pdf: PdfDocument): Promise<string> {
  const { PDFDocument } = await import("pdf-lib")
  const origBytes = await (await fetch(`/api/templates/pdf-source/${m.originalHash}`, { credentials: "same-origin" })).arrayBuffer()
  const src = await PDFDocument.load(origBytes)
  const out = await PDFDocument.create()
  for (let i = 0; i < m.pages.length; i++) {
    const mine = areas.filter((a) => a.page === i)
    if (!mine.length) {
      const [copied] = await out.copyPages(src, [i])
      out.addPage(copied)
      continue
    }
    const page = await pdf.getPage(i + 1)
    const vp = page.getViewport({ scale: K })
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(vp.width)
    canvas.height = Math.round(vp.height)
    const ctx = canvas.getContext("2d")!
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    for (const a of mine) {
      ctx.fillStyle = a.color
      ctx.fillRect(a.x * K - 1, a.y * K - 1, a.w * K + 2, a.h * K + 2)
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't draw the page"))), "image/png"))
    const img = await out.embedPng(await blob.arrayBuffer())
    const pg = out.addPage([m.pages[i].width, m.pages[i].height])
    pg.drawImage(img, { x: 0, y: 0, width: m.pages[i].width, height: m.pages[i].height })
  }
  const bytes = await out.save()
  const data = await postPdf<UploadedSource>("/api/templates/pdf-source", bytes)
  return data.sourceHash
}

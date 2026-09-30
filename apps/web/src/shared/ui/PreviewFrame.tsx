// Shows a rendered document: HTML in a sandboxed, scaled iframe, or a PDF drawn
// with pdf.js. `result` comes from a /render/… preview endpoint.
import { useEffect, useRef, useState } from "react"
import type { RenderResult } from "@doctrust/shared"
import { fetchPreviewPdf, renderPdfPages } from "../pdf"
import { errorMessage } from "../api"

const PAGE_PX = 830 // an A4 page is ~794px wide

export function PreviewFrame({ title, result }: { title: string; result: RenderResult | null }) {
  const box = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const pdfHost = useRef<HTMLDivElement>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)

  // Scale the A4-wide iframe down to fit the box.
  useEffect(() => {
    const b = box.current
    const f = frame.current
    if (!b || !f) return
    const fit = () => {
      const s = Math.min(1, b.clientWidth / PAGE_PX) || 1
      f.style.transform = `scale(${s})`
      f.style.width = `${PAGE_PX}px`
      f.style.height = `${b.clientHeight / s}px`
    }
    const ro = new ResizeObserver(fit)
    ro.observe(b)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!result || result.kind !== "pdf" || !pdfHost.current) return
    const host = pdfHost.current
    let cancelled = false
    setPdfError(null)
    host.replaceChildren(Object.assign(document.createElement("p"), { className: "loading", textContent: "Rendering…" }))
    fetchPreviewPdf(result.previewUrl)
      .then((bytes) => (cancelled ? null : renderPdfPages(host, bytes)))
      .catch((err) => !cancelled && setPdfError(errorMessage(err)))
    return () => {
      cancelled = true
    }
  }, [result])

  const isPdf = result?.kind === "pdf"
  return (
    <div className="preview-box" ref={box}>
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-scripts allow-popups"
        referrerPolicy="no-referrer"
        hidden={isPdf}
        src={!isPdf && result ? result.previewUrl : undefined}
      />
      <div className="pdf-scroll" ref={pdfHost} hidden={!isPdf} />
      {pdfError && <p className="error-box" role="alert">{pdfError}</p>}
    </div>
  )
}

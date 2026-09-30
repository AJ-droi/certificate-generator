// Checks a PDF the visitor has against the official one, entirely in the browser.
;(function () {
  const input = document.getElementById("pdf-check")
  const out = document.getElementById("pdf-result")
  if (!input || !out) return
  const label = input.nextElementSibling

  input.addEventListener("change", async () => {
    const file = input.files && input.files[0]
    if (!file) return
    label.textContent = file.name
    out.className = "check-result"
    out.textContent = "Checking…"
    if (!window.crypto || !crypto.subtle) {
      out.textContent = "Your browser can't check files here. Download the official PDF instead."
      return
    }
    const buf = await file.arrayBuffer()
    const hash = await crypto.subtle.digest("SHA-256", buf)
    const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("")
    if (hex === out.dataset.expected) {
      out.className = "check-result ok"
      out.textContent = "✓ This file is identical to the official PDF."
    } else {
      out.className = "check-result bad"
      out.textContent =
        "✕ This file is not the official PDF. It may have been edited, re-saved or printed to PDF. Compare it with the official PDF above before relying on it."
    }
  })
})()

// Generates seeds/pressure-test/form.pdf: a blank "Pressure Test Certificate"
// like one a company would upload, used by the demo seed and the tests.
//   node scripts/make-sample-form.js
const fs = require("fs")
const path = require("path")
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib")

async function makeSampleForm({ fillable = false } = {}) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89]) // A4
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const H = 841.89
  const ink = rgb(0.1, 0.12, 0.2)
  const accent = rgb(0.09, 0.3, 0.45)
  // Helpers take top-left coordinates, like the editor.
  const text = (t, x, y, size = 9, f = font, color = ink) => page.drawText(t, { x, y: H - y - size, size, font: f, color })
  const rect = (x, y, w, h, opts = {}) => page.drawRectangle({ x, y: H - y - h, width: w, height: h, borderColor: ink, borderWidth: 0.8, ...opts })
  const line = (x1, y1, x2, y2, w = 0.6) => page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: w, color: ink })

  // Header band
  rect(30, 30, 535.28, 70, { color: rgb(0.93, 0.95, 0.97), borderColor: accent })
  rect(40, 40, 50, 50, { borderColor: rgb(0.6, 0.65, 0.7) })
  text("LOGO", 52, 60, 8, font, rgb(0.55, 0.6, 0.65))
  text("PRESSURE TEST CERTIFICATE", 175, 48, 16, bold, accent)
  text("Hydrostatic / pneumatic test record  -  QA/QC Form PT-01 Rev 2", 175, 70, 8.5)
  rect(495, 38, 58, 58, { borderColor: rgb(0.6, 0.65, 0.7) })
  text("QR", 516, 62, 8, font, rgb(0.55, 0.6, 0.65))

  // Header fields
  const labelled = (label, x, y, w) => {
    text(label, x, y, 8, bold)
    line(x, y + 24, x + w, y + 24)
  }
  labelled("Certificate No.", 30, 115, 160)
  labelled("Date of Test", 215, 115, 140)
  labelled("Client", 380, 115, 185)
  labelled("Project / Location", 30, 155, 330)
  labelled("Test Standard", 380, 155, 185)

  // Test parameters box
  rect(30, 200, 535.28, 92)
  text("TEST PARAMETERS", 38, 206, 9, bold, accent)
  const params = [["Test Medium", 38, 226], ["Test Pressure (bar)", 220, 226], ["Holding Time (min)", 400, 226],
    ["Ambient Temp (°C)", 38, 258], ["Gauge Serial No.", 220, 258], ["Gauge Cal. Due", 400, 258]]
  for (const [l, x, y] of params) {
    text(l.replace("°", ""), x, y, 7.5)
    line(x, y + 22, x + 150, y + 22, 0.5)
  }

  // Items table
  const tY = 305
  text("ITEMS TESTED", 30, tY, 9, bold, accent)
  const cols = [["S/N", 30, 30], ["Tag / ID No.", 60, 90], ["Description", 150, 190], ["Size", 340, 55], ["Rating", 395, 60], ["Result", 455, 55], ["Remarks", 510, 55.28]]
  const headY = tY + 16
  rect(30, headY, 535.28, 18, { color: rgb(0.93, 0.95, 0.97) })
  for (const [l, x] of cols) text(l, x + 4, headY + 5, 7.5, bold)
  const rowH = 18
  for (let r = 0; r < 12; r++) rect(30, headY + 18 + r * rowH, 535.28, rowH)
  for (const [, x] of cols.slice(1)) line(x, headY, x, headY + 18 + 12 * rowH)

  // Result + comments
  const rY = headY + 18 + 12 * rowH + 14
  text("OVERALL RESULT", 30, rY, 9, bold, accent)
  rect(30, rY + 16, 12, 12); text("ACCEPTED", 48, rY + 18, 8.5)
  rect(130, rY + 16, 12, 12); text("REJECTED", 148, rY + 18, 8.5)
  text("Comments", 240, rY, 8, bold)
  rect(240, rY + 12, 325.28, 40)

  // Signatures
  const sY = rY + 70
  for (const [label, x] of [["Tested by", 30], ["Witnessed / Approved by", 300]]) {
    rect(x, sY, 265, 105)
    text(label, x + 8, sY + 6, 8.5, bold, accent)
    text("Name", x + 8, sY + 24, 7.5); line(x + 50, sY + 34, x + 255, sY + 34, 0.5)
    text("Qualification", x + 8, sY + 44, 7.5); line(x + 70, sY + 54, x + 255, sY + 54, 0.5)
    text("Signature", x + 8, sY + 66, 7.5); line(x + 60, sY + 90, x + 180, sY + 90, 0.5)
    text("Date", x + 188, sY + 66, 7.5); line(x + 188, sY + 90, x + 255, sY + 90, 0.5)
  }
  text("This certificate is valid only when verified online. Scan the QR code to confirm its authenticity.", 30, 812, 7, font, rgb(0.4, 0.45, 0.5))

  if (fillable) {
    const form = doc.getForm()
    const client = form.createTextField("client_name")
    client.addToPage(page, { x: 380, y: H - 115 - 24 - 2, width: 185, height: 14, borderWidth: 0 })
    const ok = form.createCheckBox("result.accepted")
    ok.addToPage(page, { x: 30, y: H - (rY + 16) - 12, width: 12, height: 12, borderWidth: 0 })
  }
  return Buffer.from(await doc.save())
}

module.exports = { makeSampleForm }

if (require.main === module) {
  makeSampleForm().then((buf) => {
    const out = path.join(__dirname, "..", "seeds", "pressure-test", "form.pdf")
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, buf)
    console.log(`Wrote ${out} (${buf.length} bytes)`)
  })
}

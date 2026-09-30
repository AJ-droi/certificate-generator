// Templates made from a company's own PDF form: upload checks, placing boxes,
// printing onto the original pages, flattening, and protection against swaps.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const h = require("../helpers")
const { makeSampleForm } = require("../../scripts/make-sample-form")

const anon = h.client()
let pdfCo
let other
let pdfAdmin
let pdfTemplateId
let pdfSourceHash

before(async () => {
  await h.startApp()
  pdfCo = await h.createCompany({ name: "Pdf Co", domain: "pdf.test", requireSeparateApprover: false })
  other = await h.createCompany({ name: "Other Co", domain: "other.test" })
  pdfAdmin = pdfCo.admin
})
after(() => h.stopApp())

test("PDF upload: rejects non-PDFs and finds fillable form fields", async () => {

  const notPdf = await h.uploadPdf(pdfAdmin, Buffer.from("%PNG this is not a pdf file at all, just some bytes padding padding padding padding"))
  assert.equal(notPdf.status, 400)

  const issuerUpload = await fetch(h.baseUrl() + "/api/templates/pdf-source", { method: "POST", headers: { "content-type": "application/pdf" }, body: await makeSampleForm() })
  assert.equal(issuerUpload.status, 401)

  const r = await h.uploadPdf(pdfAdmin, await makeSampleForm({ fillable: true }))
  assert.equal(r.status, 201, JSON.stringify(r.data))
  assert.equal(r.data.pageCount, 1)
  assert.match(r.data.sourceHash, /^[a-f0-9]{64}$/)
  const names = r.data.formFields.map((f) => f.name).sort()
  assert.deepEqual(names, ["client_name", "result.accepted"])
  const client = r.data.formFields.find((f) => f.name === "client_name")
  assert.equal(client.type, "text")
  assert.ok(Math.abs(client.x - 380) < 1 && Math.abs(client.w - 185) < 1, JSON.stringify(client))
  pdfSourceHash = r.data.sourceHash
})

test("PDF template: layout is validated against the fields and pages", async () => {
  const schema = [{ key: "client", label: "Client", type: "text", required: true }]
  const bad = await pdfAdmin("POST", "/api/templates", {
    name: "Bad", kind: "pdf", sourceHash: pdfSourceHash, schema,
    layout: { items: [{ kind: "field", key: "nope", page: 0, x: 10, y: 10, w: 50, h: 12 }, { kind: "field", key: "client", page: 3, x: 10, y: 10, w: 50, h: 12 }] },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.data.details.errors.length, 2)
  const missing = await pdfAdmin("POST", "/api/templates", { name: "X", kind: "pdf", sourceHash: "0".repeat(64), schema, layout: { items: [] } })
  assert.equal(missing.status, 400)
})

test("PDF template: issuing prints data onto the original pages, extra rows continue", async () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "seeds", "pressure-test", "template.json"), "utf8"))
  const up = await h.uploadPdf(pdfAdmin, await makeSampleForm())
  const created = await pdfAdmin("POST", "/api/templates", { ...tpl, kind: "pdf", sourceHash: up.data.sourceHash })
  assert.equal(created.status, 201, JSON.stringify(created.data))
  assert.equal(created.data.version.kind, "pdf")
  assert.deepEqual(created.data.unplaced, [])
  pdfTemplateId = created.data.template.id

  // A placement off the edge of the page is pulled back onto it.
  const clamp = await pdfAdmin("POST", "/api/templates/preview", {
    kind: "pdf", sourceHash: up.data.sourceHash, schema: tpl.schema,
    layout: { items: [{ kind: "field", key: "client", page: 0, x: 590, y: 10, w: 100, h: 12 }] }, data: {},
  })
  assert.equal(clamp.status, 200)
  assert.equal(clamp.data.kind, "pdf")

  const data = { ...tpl.settings.sampleData, client: "Zenith Offshore Ltd", items: Array.from({ length: 15 }, (_, i) => ({ tag: `TAG-${i + 1}`, description: `Spool ${i + 1}`, size: "4\"", rating: "300#", result: "PASS", remarks: "" })) }
  const d = (await pdfAdmin("POST", "/api/documents", { templateId: pdfTemplateId, data })).data.document
  assert.equal(d.documentNo, "PT/0001")

  const draftPreview = await pdfAdmin("GET", `/api/documents/${d.id}/render`)
  assert.equal(draftPreview.data.kind, "pdf")
  const draftPdf = await anon("GET", draftPreview.data.previewUrl)
  const draftText = (await h.pdfText(draftPdf.data)).join(" ")
  assert.match(draftText, /DRAFT/)
  assert.match(draftText, /Awaiting approval/, "drafts say the approval is pending")

  const issued = await pdfAdmin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  await h.settle()
  const pdf = (await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data
  const pages = await h.pdfText(pdf)
  assert.equal(pages.length, 2, "15 rows with 12 per page should make 2 pages")
  assert.match(pages[0], /Zenith Offshore Ltd/)
  assert.match(pages[0], /PT\/0001/)
  assert.match(pages[0], /TAG-12/)
  assert.doesNotMatch(pages[0], /TAG-13/)
  assert.match(pages[1], /TAG-13/)
  assert.match(pages[1], /TAG-15/)
  assert.match(pages[1], /Zenith Offshore Ltd/, "header fields repeat on continuation pages")
  assert.match(pages[0], /PRESSURE TEST CERTIFICATE/, "the original form is underneath")
  assert.doesNotMatch(pages.join(" "), /DRAFT/)
  assert.doesNotMatch(pages.join(" "), /Awaiting approval/)
  assert.match(pages[0], /Ada Admin/, "approver's name printed once approved")
  const code = issued.data.document.publicId.match(/.{4}/g).join("-")
  assert.ok(pages[0].includes(code), "verification code printed")

  const v = await anon("GET", `/api/public/verify/${issued.data.document.publicId}`)
  assert.equal(v.data.verdict, "valid")
  assert.equal(v.data.checks.recordMatches, true)
  const docView = await anon("GET", `/v/${issued.data.document.publicId}/document`)
  assert.equal(docView.headers.get("content-type"), "application/pdf")
})

test("PDF template: fillable fields are flattened, and the stored form can't be swapped", async () => {
  const up = await h.uploadPdf(pdfAdmin, await makeSampleForm({ fillable: true }))
  const schema = [{ key: "client", label: "Client", type: "text" }]
  const t = await pdfAdmin("POST", "/api/templates", {
    name: "Fillable", kind: "pdf", sourceHash: up.data.sourceHash, schema,
    layout: { items: [{ kind: "field", key: "client", page: 0, x: 380, y: 125, w: 185, h: 13 }, { kind: "system", key: "qr", page: 0, x: 496, y: 39, w: 56, h: 56 }] },
  })
  const d = (await pdfAdmin("POST", "/api/documents", { templateId: t.data.template.id, data: { client: "Flat Co" } })).data.document
  await pdfAdmin("POST", `/api/documents/${d.id}/approve`, {})
  await h.settle()
  const pdf = (await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data
  const { PDFDocument } = require("pdf-lib")
  const out = await PDFDocument.load(pdf)
  assert.equal(out.getForm().getFields().length, 0, "no editable form fields left in the issued PDF")
  const annots = out.getPage(0).node.Annots()
  assert.ok(!annots || annots.size() === 0, "no annotations/widgets left")

  // Swap the stored blank form: rendering refuses rather than printing on the wrong design.
  const [row] = await h.db.query("SELECT organization_id FROM template_versions WHERE template_id = $1", [t.data.template.id])
  const file = path.join(process.env.STORAGE_DIR, "templates", row.organization_id, `${up.data.sourceHash}.pdf`)
  const original = fs.readFileSync(file)
  fs.writeFileSync(file, await makeSampleForm())
  const r = await pdfAdmin("GET", `/api/documents/${d.id}/render`)
  assert.equal(r.status, 500)
  fs.writeFileSync(file, original)
  assert.equal((await pdfAdmin("GET", `/api/documents/${d.id}/render`)).status, 200)

  // Other companies can't read this company's uploaded form.
  assert.equal((await other.admin("GET", `/api/templates/pdf-source/${up.data.sourceHash}`)).status, 404)
})

test("PDF template: an erased copy keeps a link to the original upload", async () => {
  const original = await h.uploadPdf(pdfAdmin, await makeSampleForm())
  const cleaned = await h.uploadPdf(pdfAdmin, await makeSampleForm({ fillable: true })) // stands in for the erased copy
  const schema = [{ key: "client", label: "Client", type: "text" }]
  const items = [{ kind: "field", key: "client", page: 0, x: 380, y: 125, w: 185, h: 13, erase: true, eraseColor: "#FFFFFF" }]
  const t = await pdfAdmin("POST", "/api/templates", {
    name: "Erased", kind: "pdf", sourceHash: cleaned.data.sourceHash, schema,
    layout: { items, originalSourceHash: original.data.sourceHash },
  })
  assert.equal(t.status, 201, JSON.stringify(t.data))
  assert.equal(t.data.version.layout.originalSourceHash, original.data.sourceHash)
  assert.equal(t.data.version.layout.items[0].erase, true)
  assert.equal(t.data.version.layout.items[0].eraseColor, "#ffffff")
  // An original that was never uploaded is dropped.
  const bogus = await pdfAdmin("POST", `/api/templates/${t.data.template.id}/versions`, {
    kind: "pdf", sourceHash: cleaned.data.sourceHash, schema, layout: { items, originalSourceHash: "a".repeat(64) },
  })
  assert.equal(bogus.data.version.layout.originalSourceHash, undefined)
})

test("PDF template: text style per box, and drafts follow template changes", async () => {
  const up = await h.uploadPdf(pdfAdmin, await makeSampleForm())
  const schema = [{ key: "client", label: "Client", type: "text" }]
  const item = { kind: "field", key: "client", page: 0, x: 380, y: 120, w: 185, h: 20, font: "serif", bold: true, color: "#1A2B3C" }
  const t = await pdfAdmin("POST", "/api/templates", { name: "Styled", kind: "pdf", sourceHash: up.data.sourceHash, schema, layout: { items: [item] } })
  assert.equal(t.status, 201, JSON.stringify(t.data))
  const saved = t.data.version.layout.items[0]
  assert.deepEqual([saved.font, saved.bold, saved.color], ["serif", true, "#1a2b3c"])

  const d = (await pdfAdmin("POST", "/api/documents", { templateId: t.data.template.id, data: { client: "Styled Ltd" } })).data.document
  const draftVersion = d.templateVersionId

  // The admin changes the template: a new field.
  const v2 = await pdfAdmin("POST", `/api/templates/${t.data.template.id}/versions`, {
    kind: "pdf", sourceHash: up.data.sourceHash,
    schema: [...schema, { key: "site", label: "Site", type: "text" }],
    layout: { items: [item, { kind: "field", key: "site", page: 0, x: 30, y: 160, w: 300, h: 16 }] },
  })
  assert.equal(v2.status, 201)
  // The open draft shows the new field straight away and moves to v2 on save.
  const view = await pdfAdmin("GET", `/api/documents/${d.id}`)
  assert.ok(view.data.version.schema.some((f) => f.key === "site"))
  const saved2 = await pdfAdmin("PATCH", `/api/documents/${d.id}`, { data: { client: "Styled Ltd", site: "Onne" } })
  assert.equal(saved2.status, 200, JSON.stringify(saved2.data))
  assert.notEqual(saved2.data.document.templateVersionId, draftVersion)
  assert.equal(saved2.data.document.templateVersionId, v2.data.version.id)
  assert.equal(saved2.data.document.data.site, "Onne")

  const issued = await pdfAdmin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  await h.settle()
  const text = (await h.pdfText((await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data)).join(" ")
  assert.match(text, /Styled Ltd/)
  assert.match(text, /Onne/)
  const { PDFDocument } = require("pdf-lib")
  const out = await PDFDocument.load((await pdfAdmin("GET", `/api/documents/${d.id}/pdf`)).data)
  const fonts = [...out.context.enumerateIndirectObjects()].map(([, o]) => o && o.get && o.get(require("pdf-lib").PDFName.of("BaseFont"))).filter(Boolean).map(String)
  assert.ok(fonts.some((f) => /Times-Bold/.test(f)), `expected Times-Bold, got ${fonts}`)
})

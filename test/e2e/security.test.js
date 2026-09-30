// Company isolation and rendering customer templates safely.
const { test, before, after } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const http = require("node:http")
const h = require("../helpers")

let acme
let other
let acmeTemplateId
let acmeDoc

before(async () => {
  await h.startApp()
  acme = await h.createCompany({ name: "Acme Inspections", domain: "acme.test" })
  other = await h.createCompany({ name: "Other Co", domain: "other.test", requireSeparateApprover: false })
  acmeTemplateId = (await acme.admin("POST", "/api/templates", { name: "Report", html: h.HTML, schema: h.SCHEMA })).data.template.id
  acmeDoc = await h.issueDocument(acme, acmeTemplateId)
})
after(() => h.stopApp())

test("companies can't see or touch each other's data", async () => {
  const o = other.admin
  assert.equal((await o("GET", `/api/documents/${acmeDoc.id}`)).status, 404)
  assert.equal((await o("GET", `/api/documents/${acmeDoc.id}/pdf`)).status, 404)
  assert.equal((await o("GET", `/api/templates/${acmeTemplateId}`)).status, 404)
  assert.equal((await o("POST", "/api/documents", { templateId: acmeTemplateId, data: h.DATA })).status, 404)
  assert.equal((await o("POST", `/api/documents/${acmeDoc.id}/revoke`, { reason: "x" })).status, 404)
  assert.equal((await o("POST", `/api/documents/${acmeDoc.id}/retry-pdf`, {})).status, 404)
  assert.equal((await o("GET", "/api/documents")).data.total, 0)
  assert.equal((await o("GET", "/api/users")).data.users.length, 3)
  const acmeUsers = (await acme.admin("GET", "/api/users")).data.users
  assert.equal((await o("PATCH", `/api/users/${acmeUsers[0].id}`, { active: false })).status, 404)
  assert.equal((await o("GET", "/api/documents/not-a-uuid")).status, 404)
})

test("templates can't reach local files or internal services when the PDF is made", async () => {
  let hits = 0
  const internal = http.createServer((req, res) => {
    hits++
    res.end("secret")
  }).listen(0, "127.0.0.1")
  await new Promise((r) => internal.once("listening", r))
  const port = internal.address().port
  const secretFile = path.join(process.env.STORAGE_DIR, "secret.txt")
  fs.writeFileSync(secretFile, "TOP-SECRET-VALUE")
  const html = `<html><body><p>hello</p>
    <iframe src="file://${secretFile}"></iframe>
    <img src="http://127.0.0.1:${port}/img.png">
    <link rel="stylesheet" href="http://127.0.0.1:${port}/style.css">
    <script>fetch("http://127.0.0.1:${port}/js").catch(()=>{}); document.write('<iframe src="file://${secretFile}"></iframe>')</script>
  </body></html>`
  const t = await other.admin("POST", "/api/templates", { name: "Evil", html, schema: [{ key: "a", label: "A", type: "text" }] })
  assert.equal(t.status, 201)
  const d = (await other.admin("POST", "/api/documents", { templateId: t.data.template.id, data: { a: "x" } })).data.document
  const issued = await other.admin("POST", `/api/documents/${d.id}/approve`, {})
  assert.equal(issued.status, 200, JSON.stringify(issued.data))
  await h.settle()
  internal.close()
  assert.equal(hits, 0, "the headless browser reached an internal service")
  const pdf = await other.admin("GET", `/api/documents/${d.id}/pdf`)
  assert.equal(pdf.status, 200)
  assert.ok(!pdf.data.includes("TOP-SECRET-VALUE"))

  const { isAllowed } = require("../../src/services/pdf.service")
  const hosts = new Set(["cdn.jsdelivr.net"])
  assert.equal(isAllowed(`file://${secretFile}`, hosts), false)
  assert.equal(isAllowed("http://169.254.169.254/latest/meta-data", hosts), false)
  assert.equal(isAllowed("http://cdn.jsdelivr.net/x.css", hosts), false)
  assert.equal(isAllowed("https://cdn.jsdelivr.net/x.css", hosts), true)
  assert.equal(isAllowed("data:image/png;base64,AAAA", hosts), true)
})

test("previews are served sandboxed and expire; tokens can't be guessed", async () => {
  const p = await acme.admin("POST", "/api/templates/preview", { html: h.HTML, schema: h.SCHEMA, data: h.DATA })
  const anon = h.client()
  const page = await anon("GET", p.data.previewUrl)
  assert.equal(page.status, 200)
  assert.match(page.headers.get("content-security-policy"), /^sandbox/)
  assert.equal((await anon("GET", "/render/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status, 404)
  assert.equal((await anon("GET", "/render/../../etc/passwd")).status, 404)
})

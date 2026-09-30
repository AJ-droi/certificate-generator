// Company dashboard API. Routes only translate HTTP to service calls; the rules
// live in src/services.
const express = require("express")
const { requireAuth, requireRole } = require("../lib/auth")
const { requestContext } = require("../lib/context")
const { isUuid } = require("../lib/validate")
const { notFound, badRequest } = require("../lib/errors")
const renderCache = require("../lib/render-cache")
const { SYSTEM_ITEMS, unplacedFields } = require("../lib/pdf-overlay")
const orgs = require("../services/org.service")
const users = require("../services/user.service")
const templates = require("../services/template.service")
const documents = require("../services/document.service")
const storage = require("../services/storage.service")
const { companyActivity } = require("../services/activity.service")

const router = express.Router()
router.use(requireAuth)
router.use((req, res, next) => {
  req.ctx = requestContext(req)
  next()
})

for (const name of ["id", "versionId"]) {
  router.param(name, (req, res, next, id) => {
    if (!isUuid(id)) throw notFound()
    next()
  })
}

const orgId = (req) => req.user.organizationId
const preview = async (out) => ({ kind: out.kind, previewUrl: `/render/${await renderCache.put(out)}` })
const pdfFilename = (documentNo) => `${documentNo.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`

// ---- Profile & company -------------------------------------------------------

router.patch("/me", async (req, res) => {
  res.json({ user: await users.updateProfile(req.ctx, req.body) })
})

router.patch("/org", requireRole("admin"), async (req, res) => {
  res.json({ organization: orgs.publicOrg(await orgs.updateOrgSettings(req.ctx, req.body)) })
})

router.post("/org/verification", requireRole("admin"), async (req, res) => {
  res.json({ organization: orgs.publicOrg(await orgs.requestVerification(req.ctx, req.body || {})) })
})

router.post("/org/verification/check-domain", requireRole("admin"), async (req, res) => {
  const { org, found } = await orgs.checkDomain(req.ctx)
  res.json({ found, organization: orgs.publicOrg(org) })
})

// ---- People ---------------------------------------------------------------------

router.get("/users", async (req, res) => {
  res.json({ users: await users.listUsers(orgId(req)) })
})

router.post("/users", requireRole("admin"), async (req, res) => {
  res.status(201).json(await users.inviteUser(req.ctx, req.body))
})

router.patch("/users/:id", requireRole("admin"), async (req, res) => {
  res.json({ user: await users.updateUser(req.ctx, req.params.id, req.body) })
})

router.post("/users/:id/reset-password", requireRole("admin"), async (req, res) => {
  res.json(await users.resetUserPassword(req.ctx, req.params.id))
})

// ---- Templates -------------------------------------------------------------------

router.get("/templates", async (req, res) => {
  res.json({ templates: await templates.listTemplates(orgId(req)) })
})

router.post("/templates", requireRole("admin"), async (req, res) => {
  const { template, version } = await templates.createTemplate(req.ctx, req.body || {})
  const unplaced = version.kind === "pdf" ? unplacedFields(version.schema, version.layout) : []
  res.status(201).json({ template, version, unplaced })
})

// Upload the company's PDF form. Returns its fingerprint, page sizes and any
// fillable form fields the editor can turn into fields automatically.
router.post(
  "/templates/pdf-source",
  requireRole("admin"),
  express.raw({ type: "application/pdf", limit: "15mb" }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.is("application/pdf")) throw badRequest("Upload a PDF file")
    res.status(201).json(await templates.uploadSource(req.ctx, req.body))
  },
)

router.get("/templates/pdf-source/:hash", async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.hash)) throw notFound()
  if (!(await storage.hasTemplateSource(orgId(req), req.params.hash))) throw notFound()
  const pdf = await storage.readTemplateSource(orgId(req), req.params.hash)
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Cache-Control", "private, max-age=3600")
  res.send(pdf)
})

router.get("/templates/system-items", (req, res) => {
  res.json({ items: Object.entries(SYSTEM_ITEMS).map(([key, v]) => ({ key, ...v })) })
})

router.get("/templates/:id", async (req, res) => {
  res.json(await templates.templateDetail(orgId(req), req.params.id))
})

router.get("/templates/:id/versions/:versionId", async (req, res) => {
  res.json({ version: await templates.templateVersion(orgId(req), req.params.id, req.params.versionId) })
})

router.patch("/templates/:id", requireRole("admin"), async (req, res) => {
  res.json({ template: await templates.updateTemplate(req.ctx, req.params.id, req.body) })
})

// Saving the layout or fields creates a new version. Documents keep the version they were made with.
router.post("/templates/:id/versions", requireRole("admin"), async (req, res) => {
  const result = await templates.addVersion(req.ctx, req.params.id, req.body || {})
  const unplaced = result.version.kind === "pdf" ? unplacedFields(result.version.schema, result.version.layout) : []
  res.status(result.unchanged ? 200 : 201).json({ ...result, unplaced })
})

router.post("/templates/preview", async (req, res) => {
  res.json(await preview(await documents.renderPreview(req.ctx, req.body || {})))
})

// ---- Documents -------------------------------------------------------------------

router.get("/documents", async (req, res) => {
  res.json(await documents.listDocuments(orgId(req), req.query))
})

router.post("/documents", async (req, res) => {
  res.status(201).json({ document: await documents.createDocument(req.ctx, req.body || {}) })
})

router.get("/documents/:id", async (req, res) => {
  res.json(await documents.documentDetail(req.ctx, req.params.id))
})

router.patch("/documents/:id", async (req, res) => {
  res.json({ document: await documents.updateDraft(req.ctx, req.params.id, req.body || {}) })
})

router.delete("/documents/:id", async (req, res) => {
  await documents.deleteDraft(req.ctx, req.params.id)
  res.json({ ok: true })
})

router.post("/documents/:id/submit", async (req, res) => {
  res.json({ document: await documents.submitForApproval(req.ctx, req.params.id) })
})
router.post("/documents/:id/send-back", async (req, res) => {
  res.json({ document: await documents.sendBack(req.ctx, req.params.id, req.body || {}) })
})
router.post("/documents/:id/approve", async (req, res) => {
  res.json({ document: await documents.approveAndIssue(req.ctx, req.params.id) })
})
router.post("/documents/:id/revoke", async (req, res) => {
  res.json({ document: await documents.revoke(req.ctx, req.params.id, req.body || {}) })
})
router.post("/documents/:id/correct", async (req, res) => {
  res.status(201).json({ document: await documents.startCorrection(req.ctx, req.params.id) })
})
router.post("/documents/:id/retry-pdf", async (req, res) => {
  res.json({ document: await documents.retryPdf(req.ctx, req.params.id) })
})

router.get("/documents/:id/render", async (req, res) => {
  const doc = await documents.findOrgDocument(orgId(req), req.params.id)
  res.json(await preview(await documents.renderForDashboard(req.ctx, doc)))
})

router.get("/documents/:id/pdf", async (req, res) => {
  const { doc, pdf } = await documents.readDocumentPdf(orgId(req), req.params.id)
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `attachment; filename="${pdfFilename(doc.documentNo)}"`)
  res.send(pdf)
})

// ---- Activity log ------------------------------------------------------------------

router.get("/audit", requireRole("admin"), async (req, res) => {
  res.json({ events: await companyActivity(orgId(req), { limit: req.query.limit }) })
})

module.exports = router

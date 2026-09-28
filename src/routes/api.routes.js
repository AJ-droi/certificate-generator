const express = require("express")
const { In } = require("typeorm")
const { repo } = require("../config/database")
const { ROLES, requireAuth, requireRole, publicUser, hashPassword } = require("../lib/auth")
const { publicOrg, normalizeEmail, cleanName } = require("../services/org.service")
const templates = require("../services/template.service")
const documents = require("../services/document.service")
const storage = require("../services/storage.service")
const { audit } = require("../lib/audit")
const renderCache = require("../lib/render-cache")
const { SYSTEM_ITEMS, unplacedFields } = require("../lib/pdf-overlay")
const { randomPassword } = require("../lib/crypto")
const { badRequest, notFound, conflict } = require("../lib/errors")

const router = express.Router()
router.use(requireAuth)

const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/
function cleanImage(value, label) {
  if (value === null || value === "") return null
  if (typeof value !== "string" || !IMAGE_RE.test(value)) throw badRequest(`${label} must be a PNG, JPEG, WebP or GIF image`)
  if (value.length > 700_000) throw badRequest(`${label} is too large (max ~500 KB)`)
  return value
}

const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))
for (const name of ["id", "versionId"]) {
  router.param(name, (req, res, next, id) => {
    if (!isUuid(id)) throw notFound()
    next()
  })
}

async function namesById(ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Map()
  const users = await repo("User").find({ where: { id: In(unique) }, select: ["id", "name"] })
  return new Map(users.map((u) => [u.id, u.name]))
}

// ---- Profile & company -------------------------------------------------------

router.patch("/me", async (req, res) => {
  const { name, qualification, signature } = req.body || {}
  const user = req.user
  if (name !== undefined) user.name = cleanName(name, "Name")
  if (qualification !== undefined) user.qualification = String(qualification || "").slice(0, 500)
  if (signature !== undefined) user.signature = cleanImage(signature, "Signature")
  await repo("User").save(user)
  await audit(req, "user.profile_updated", { entityType: "user", entityId: user.id })
  res.json({ user: publicUser(user) })
})

router.patch("/org", requireRole("admin"), async (req, res) => {
  const { name, logo, requireSeparateApprover } = req.body || {}
  const org = await repo("Organization").findOne({ where: { id: req.user.organizationId } })
  if (name !== undefined) org.name = cleanName(name, "Company name")
  if (logo !== undefined) org.logo = cleanImage(logo, "Logo")
  if (requireSeparateApprover !== undefined) org.requireSeparateApprover = Boolean(requireSeparateApprover)
  await repo("Organization").save(org)
  await audit(req, "organization.updated", {
    entityType: "organization",
    entityId: org.id,
    details: { name: org.name, requireSeparateApprover: org.requireSeparateApprover, logoChanged: logo !== undefined },
  })
  res.json({ organization: publicOrg(org) })
})

// ---- Users ---------------------------------------------------------------------

router.get("/users", async (req, res) => {
  const users = await repo("User").find({ where: { organizationId: req.user.organizationId }, order: { createdAt: "ASC" } })
  res.json({ users: users.map(publicUser) })
})

router.post("/users", requireRole("admin"), async (req, res) => {
  const { email, name, role } = req.body || {}
  if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`)
  const mail = normalizeEmail(email)
  if (await repo("User").findOne({ where: { email: mail } })) throw conflict("An account with this email already exists")
  const temporaryPassword = randomPassword()
  const user = await repo("User").save({
    organizationId: req.user.organizationId,
    email: mail,
    name: cleanName(name, "Name"),
    role,
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
  })
  await audit(req, "user.created", { entityType: "user", entityId: user.id, details: { email: mail, role } })
  // The temporary password is shown once to the admin, who passes it on.
  res.status(201).json({ user: publicUser(user), temporaryPassword })
})

async function orgUser(req) {
  const user = await repo("User").findOne({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!user) throw notFound("User not found")
  return user
}

async function ensureAnotherAdmin(req, user) {
  const admins = await repo("User").count({ where: { organizationId: req.user.organizationId, role: "admin", active: true } })
  if (user.role === "admin" && user.active && admins <= 1) throw conflict("A company needs at least one active admin")
}

router.patch("/users/:id", requireRole("admin"), async (req, res) => {
  const user = await orgUser(req)
  const { role, active, name } = req.body || {}
  if ((role !== undefined && role !== "admin") || active === false) await ensureAnotherAdmin(req, user)
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`)
    user.role = role
  }
  if (name !== undefined) user.name = cleanName(name, "Name")
  if (active !== undefined) {
    user.active = Boolean(active)
    if (!user.active) user.tokenVersion += 1
  }
  await repo("User").save(user)
  await audit(req, "user.updated", { entityType: "user", entityId: user.id, details: { role: user.role, active: user.active } })
  res.json({ user: publicUser(user) })
})

router.post("/users/:id/reset-password", requireRole("admin"), async (req, res) => {
  const user = await orgUser(req)
  const temporaryPassword = randomPassword()
  user.passwordHash = await hashPassword(temporaryPassword)
  user.mustChangePassword = true
  user.tokenVersion += 1
  await repo("User").save(user)
  await audit(req, "user.password_reset", { entityType: "user", entityId: user.id })
  res.json({ temporaryPassword })
})

// ---- Templates -------------------------------------------------------------------

router.get("/templates", async (req, res) => {
  const list = await repo("Template").find({ where: { organizationId: req.user.organizationId }, order: { name: "ASC" } })
  const versions = list.length
    ? await repo("TemplateVersion")
        .createQueryBuilder("v")
        .select(["v.id", "v.version", "v.kind", "v.schema", "v.settings", "v.createdAt"])
        .where("v.id IN (:...ids)", { ids: list.map((t) => t.currentVersionId).filter(Boolean) })
        .getMany()
    : []
  const byId = new Map(versions.map((v) => [v.id, v]))
  res.json({
    templates: list.map((t) => ({ ...t, currentVersion: byId.get(t.currentVersionId) || null })),
  })
})

router.post("/templates", requireRole("admin"), async (req, res) => {
  const { template, version } = await templates.createTemplate(req.user, req.body || {})
  await audit(req, "template.created", { entityType: "template", entityId: template.id, details: { name: template.name, kind: version.kind } })
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
    const result = await templates.uploadSource(req.user, req.body)
    await audit(req, "template.pdf_uploaded", {
      entityType: "template_source",
      entityId: result.sourceHash,
      details: { pages: result.pageCount, bytes: req.body.length, formFields: result.formFields.length },
    })
    res.status(201).json(result)
  },
)

router.get("/templates/pdf-source/:hash", async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.hash)) throw notFound()
  if (!(await storage.hasTemplateSource(req.user.organizationId, req.params.hash))) throw notFound()
  const pdf = await storage.readTemplateSource(req.user.organizationId, req.params.hash)
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Cache-Control", "private, max-age=3600")
  res.send(pdf)
})

router.get("/templates/system-items", (req, res) => {
  res.json({ items: Object.entries(SYSTEM_ITEMS).map(([key, v]) => ({ key, ...v })) })
})

router.get("/templates/:id", async (req, res) => {
  const template = await templates.getTemplate(req.user.organizationId, req.params.id)
  const version = await templates.getVersion(req.user.organizationId, template.currentVersionId)
  const history = await repo("TemplateVersion").find({
    where: { templateId: template.id },
    select: ["id", "version", "contentHash", "createdAt", "createdBy"],
    order: { version: "DESC" },
  })
  res.json({ template, version, history })
})

router.get("/templates/:id/versions/:versionId", async (req, res) => {
  const v = await templates.getVersion(req.user.organizationId, req.params.versionId)
  if (v.templateId !== req.params.id) throw notFound()
  res.json({ version: v })
})

router.patch("/templates/:id", requireRole("admin"), async (req, res) => {
  const template = await templates.getTemplate(req.user.organizationId, req.params.id)
  const { name, description, archived } = req.body || {}
  if (name !== undefined) template.name = cleanName(name, "Template name")
  if (description !== undefined) template.description = String(description || "").slice(0, 2000)
  if (archived !== undefined) template.archived = Boolean(archived)
  await repo("Template").save(template)
  await audit(req, "template.updated", { entityType: "template", entityId: template.id, details: { archived: template.archived } })
  res.json({ template })
})

// Saving the layout or fields creates a new version. Documents keep the version they were made with.
router.post("/templates/:id/versions", requireRole("admin"), async (req, res) => {
  const result = await templates.addVersion(req.user, req.params.id, req.body || {})
  if (!result.unchanged) {
    await audit(req, "template.version_created", {
      entityType: "template",
      entityId: req.params.id,
      details: { version: result.version.version },
    })
  }
  const warnings = result.version.kind === "pdf" ? unplacedFields(result.version.schema, result.version.layout) : []
  res.status(result.unchanged ? 200 : 201).json({ ...result, unplaced: warnings })
})

router.post("/templates/preview", async (req, res) => {
  const out = await documents.renderPreview(req, req.body || {})
  res.json({ kind: out.kind, previewUrl: `/render/${renderCache.put(out)}` })
})

// ---- Documents -------------------------------------------------------------------

const STATUSES = ["draft", "pending_approval", "issued", "revoked", "superseded"]

router.get("/documents", async (req, res) => {
  const { status, templateId, q } = req.query
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
  const offset = Math.max(0, Number(req.query.offset) || 0)
  const qb = repo("Document")
    .createQueryBuilder("d")
    .select([
      "d.id", "d.documentNo", "d.status", "d.templateId", "d.createdBy", "d.issuedAt",
      "d.createdAt", "d.updatedAt", "d.publicId", "d.supersedesId",
    ])
    .where("d.organization_id = :org", { org: req.user.organizationId })
  if (status && STATUSES.includes(status)) qb.andWhere("d.status = :status", { status })
  if (templateId && isUuid(templateId)) qb.andWhere("d.template_id = :templateId", { templateId })
  if (q) {
    qb.andWhere("(d.document_no ILIKE :q OR d.data::text ILIKE :q)", { q: `%${String(q).replace(/[%_\\]/g, "\\$&").slice(0, 100)}%` })
  }
  const [rows, total] = await qb.orderBy("d.updated_at", "DESC").skip(offset).take(limit).getManyAndCount()
  const counts = await repo("Document")
    .createQueryBuilder("d")
    .select("d.status", "status")
    .addSelect("COUNT(*)::int", "count")
    .where("d.organization_id = :org", { org: req.user.organizationId })
    .groupBy("d.status")
    .getRawMany()
  res.json({ documents: rows, total, counts: Object.fromEntries(counts.map((c) => [c.status, c.count])) })
})

router.post("/documents", async (req, res) => {
  const doc = await documents.createDocument(req, req.body || {})
  res.status(201).json({ document: doc })
})

async function orgDocument(req) {
  const doc = await repo("Document").findOne({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!doc) throw notFound("Document not found")
  return doc
}

router.get("/documents/:id", async (req, res) => {
  const doc = await orgDocument(req)
  // A draft shows the latest template version's fields (it moves to it on save).
  const version = doc.status === "draft"
    ? await documents.moveToLatestVersion({ ...doc })
    : await templates.getVersion(req.user.organizationId, doc.templateVersionId)
  const template = await templates.getTemplate(req.user.organizationId, doc.templateId)
  const related = await repo("Document").find({
    where: [
      ...[doc.supersedesId, doc.supersededById].filter(Boolean).map((id) => ({ id })),
      { supersedesId: doc.id },
    ],
    select: ["id", "documentNo", "status", "supersedesId"],
  })
  const history = await repo("AuditEvent").find({ where: { entityId: doc.id }, order: { createdAt: "ASC" }, take: 200 })
  const names = await namesById([doc.createdBy, doc.issuedBy, doc.revokedBy, ...history.map((h) => h.userId)])
  res.json({
    document: doc,
    template: { id: template.id, name: template.name, currentVersionId: template.currentVersionId },
    version: { id: version.id, version: version.version, schema: version.schema },
    related,
    people: Object.fromEntries(names),
    history: history.map((h) => ({ ...h, userName: h.userId ? names.get(h.userId) || "" : "Public" })),
    verifyUrl: doc.publicId ? `${documents.baseUrl(req)}/v/${doc.publicId}` : null,
  })
})

router.patch("/documents/:id", async (req, res) => {
  const doc = await documents.updateDraft(req, req.params.id, req.body || {})
  res.json({ document: doc })
})

router.delete("/documents/:id", async (req, res) => {
  await documents.deleteDraft(req, req.params.id)
  res.json({ ok: true })
})

router.post("/documents/:id/submit", async (req, res) => {
  res.json({ document: await documents.submitForApproval(req, req.params.id) })
})
router.post("/documents/:id/send-back", async (req, res) => {
  res.json({ document: await documents.sendBack(req, req.params.id, req.body || {}) })
})
router.post("/documents/:id/approve", async (req, res) => {
  res.json({ document: await documents.approveAndIssue(req, req.params.id) })
})
router.post("/documents/:id/revoke", async (req, res) => {
  res.json({ document: await documents.revoke(req, req.params.id, req.body || {}) })
})
router.post("/documents/:id/correct", async (req, res) => {
  res.status(201).json({ document: await documents.startCorrection(req, req.params.id) })
})

router.get("/documents/:id/render", async (req, res) => {
  const doc = await orgDocument(req)
  const out = await documents.renderForDashboard(req, doc)
  res.json({ kind: out.kind, previewUrl: `/render/${renderCache.put(out)}` })
})

router.get("/documents/:id/pdf", async (req, res) => {
  const doc = await orgDocument(req)
  if (!doc.pdfPath) throw notFound("There's no PDF until the document is issued")
  const pdf = await storage.readFile(doc.pdfPath)
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `attachment; filename="${doc.documentNo.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf"`)
  res.send(pdf)
})

// ---- Audit log ------------------------------------------------------------------

router.get("/audit", requireRole("admin"), async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  const events = await repo("AuditEvent").find({
    where: { organizationId: req.user.organizationId },
    order: { createdAt: "DESC" },
    take: limit,
  })
  const names = await namesById(events.map((e) => e.userId))
  res.json({ events: events.map((e) => ({ ...e, userName: e.userId ? names.get(e.userId) || "" : "Public" })) })
})

module.exports = router

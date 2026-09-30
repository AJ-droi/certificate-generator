const { AppDataSource, repo } = require("../config/database")
const { validateSchema, normalizeData } = require("../lib/schema")
const { checkTemplateSyntax } = require("../lib/render")
const { inspectSourcePdf, validateLayout } = require("../lib/pdf-overlay")
const storage = require("./storage.service")
const { canonicalJson, sha256 } = require("../lib/crypto")
const { audit } = require("../lib/audit")
const { cleanName } = require("./org.service")
const { badRequest, notFound } = require("../lib/errors")

const MAX_HTML = 1_000_000

function cleanSettings(settings = {}, schema) {
  const s = settings && typeof settings === "object" ? settings : {}
  const numberPrefix = String(s.numberPrefix ?? "").slice(0, 60)
  if (numberPrefix && !/^[A-Za-z0-9/\-_. ]*$/.test(numberPrefix)) {
    throw badRequest("Number prefix may only use letters, numbers and / - _ .")
  }
  const numberPadding = Math.min(8, Math.max(1, Number(s.numberPadding) || 4))
  let sampleData = {}
  if (s.sampleData && typeof s.sampleData === "object") {
    try {
      sampleData = normalizeData(schema, s.sampleData)
    } catch (err) {
      throw badRequest("Sample data doesn't match the fields", err.details)
    }
  }
  return { numberPrefix, numberPadding, sampleData }
}

function parseSchema(schema) {
  let parsed = schema
  if (typeof schema === "string") {
    try {
      parsed = JSON.parse(schema)
    } catch (err) {
      throw badRequest(`Field schema is not valid JSON: ${err.message}`)
    }
  }
  return validateSchema(parsed)
}

// Validates a template version. `kind` is "html" (default) or "pdf".
async function prepareVersion({ kind = "html", html, schema, settings, sourceHash, layout }, organizationId) {
  const cleanSchema = parseSchema(schema)
  const cleanSet = cleanSettings(settings, cleanSchema)
  const { sampleData, ...hashedSettings } = cleanSet

  if (kind === "pdf") {
    if (!/^[a-f0-9]{64}$/.test(String(sourceHash || ""))) throw badRequest("Upload the PDF first")
    if (!(await storage.hasTemplateSource(organizationId, sourceHash))) throw badRequest("The uploaded PDF wasn't found. Upload it again.")
    const source = await storage.readTemplateSource(organizationId, sourceHash)
    if (sha256(source) !== sourceHash) throw badRequest("The stored PDF doesn't match its fingerprint. Upload it again.")
    const info = await inspectSourcePdf(source)
    const cleanLayout = { pages: info.pages, ...validateLayout(layout, cleanSchema, info.pages) }
    // When text was erased from the form, `sourceHash` is the cleaned copy and
    // this is the PDF as uploaded, so the editor can redo the erasing later.
    const original = layout && layout.originalSourceHash
    if (original && original !== sourceHash && /^[a-f0-9]{64}$/.test(String(original)) && (await storage.hasTemplateSource(organizationId, original))) {
      cleanLayout.originalSourceHash = original
    }
    return {
      kind: "pdf",
      html: "",
      sourceHash,
      layout: cleanLayout,
      schema: cleanSchema,
      settings: cleanSet,
      contentHash: sha256(canonicalJson({ kind: "pdf", sourceHash, layout: cleanLayout, schema: cleanSchema, settings: hashedSettings })),
    }
  }

  if (typeof html !== "string" || !html.trim()) throw badRequest("Template HTML is required")
  if (html.length > MAX_HTML) throw badRequest("Template HTML is too large (max 1 MB)")
  checkTemplateSyntax(html)
  return {
    kind: "html",
    html,
    sourceHash: null,
    layout: null,
    schema: cleanSchema,
    settings: cleanSet,
    contentHash: sha256(canonicalJson({ html, schema: cleanSchema, settings: hashedSettings })),
  }
}

// Stores an uploaded PDF (by fingerprint) and reports its pages and fillable fields.
async function uploadSource(ctx, buffer) {
  const info = await inspectSourcePdf(buffer)
  const hash = sha256(buffer)
  await storage.saveTemplateSource(ctx.user.organizationId, hash, buffer)
  await audit(ctx, "template.pdf_uploaded", {
    entityType: "template_source",
    entityId: hash,
    details: { pages: info.pageCount, bytes: buffer.length, formFields: info.formFields.length },
  })
  return { sourceHash: hash, ...info }
}

async function createTemplate(ctx, { name, description, ...input }) {
  const user = ctx.user
  const title = String(name || "").trim()
  if (!title) throw badRequest("Template name is required")
  const version = await prepareVersion(input, user.organizationId)
  return AppDataSource.transaction(async (m) => {
    const template = await m.getRepository("Template").save({
      organizationId: user.organizationId,
      name: title.slice(0, 200),
      description: String(description || "").slice(0, 2000),
    })
    const v = await m.getRepository("TemplateVersion").save({
      ...version,
      templateId: template.id,
      organizationId: user.organizationId,
      version: 1,
      createdBy: user.id,
    })
    template.currentVersionId = v.id
    await m.getRepository("Template").save(template)
    await audit(ctx, "template.created", { entityType: "template", entityId: template.id, details: { name: template.name, kind: v.kind } }, m)
    return { template, version: v }
  })
}

async function addVersion(ctx, templateId, input) {
  const user = ctx.user
  const prepared = await prepareVersion(input, user.organizationId)
  return AppDataSource.transaction(async (m) => {
    const template = await m
      .getRepository("Template")
      .createQueryBuilder("t")
      .setLock("pessimistic_write")
      .where("t.id = :id AND t.organization_id = :org", { id: templateId, org: user.organizationId })
      .getOne()
    if (!template) throw notFound("Template not found")
    const current = await m.getRepository("TemplateVersion").findOne({ where: { id: template.currentVersionId } })
    if (current && current.contentHash === prepared.contentHash &&
        canonicalJson(current.settings.sampleData) === canonicalJson(prepared.settings.sampleData)) {
      return { template, version: current, unchanged: true }
    }
    const last = await m.getRepository("TemplateVersion").findOne({
      where: { templateId },
      order: { version: "DESC" },
    })
    const v = await m.getRepository("TemplateVersion").save({
      ...prepared,
      templateId,
      organizationId: user.organizationId,
      version: (last ? last.version : 0) + 1,
      createdBy: user.id,
    })
    template.currentVersionId = v.id
    await m.getRepository("Template").save(template)
    await audit(ctx, "template.version_created", { entityType: "template", entityId: template.id, details: { version: v.version } }, m)
    return { template, version: v }
  })
}

async function listTemplates(orgId) {
  const list = await repo("Template").find({ where: { organizationId: orgId }, order: { name: "ASC" } })
  const ids = list.map((t) => t.currentVersionId).filter(Boolean)
  const versions = ids.length
    ? await repo("TemplateVersion")
        .createQueryBuilder("v")
        .select(["v.id", "v.version", "v.kind", "v.schema", "v.settings", "v.createdAt"])
        .where("v.id IN (:...ids)", { ids })
        .getMany()
    : []
  const byId = new Map(versions.map((v) => [v.id, v]))
  return list.map((t) => ({ ...t, currentVersion: byId.get(t.currentVersionId) || null }))
}

async function templateDetail(orgId, id) {
  const template = await getTemplate(orgId, id)
  const version = await getVersion(orgId, template.currentVersionId)
  const history = await repo("TemplateVersion").find({
    where: { templateId: template.id },
    select: ["id", "version", "contentHash", "createdAt", "createdBy"],
    order: { version: "DESC" },
  })
  return { template, version, history }
}

async function templateVersion(orgId, templateId, versionId) {
  const v = await getVersion(orgId, versionId)
  if (v.templateId !== templateId) throw notFound("Template version not found")
  return v
}

// Name, description, archived. (The layout changes through addVersion.)
async function updateTemplate(ctx, id, { name, description, archived } = {}) {
  const template = await getTemplate(ctx.user.organizationId, id)
  if (name !== undefined) template.name = cleanName(name, "Template name")
  if (description !== undefined) template.description = String(description || "").slice(0, 2000)
  if (archived !== undefined) template.archived = Boolean(archived)
  await repo("Template").save(template)
  await audit(ctx, "template.updated", { entityType: "template", entityId: template.id, details: { archived: template.archived } })
  return template
}

async function getTemplate(orgId, id) {
  const template = await repo("Template").findOne({ where: { id, organizationId: orgId } })
  if (!template) throw notFound("Template not found")
  return template
}

async function getVersion(orgId, id) {
  const v = await repo("TemplateVersion").findOne({ where: { id, organizationId: orgId } })
  if (!v) throw notFound("Template version not found")
  return v
}

// Atomically reserves the next number for a template, e.g. "ELS/MTC-0007".
// Skips numbers already used in the company (templates can share a prefix).
async function nextDocumentNo(manager, template, version) {
  const { numberPrefix = "", numberPadding = 4 } = version.settings || {}
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rows = await manager.query(
      "UPDATE templates SET next_sequence = next_sequence + 1 WHERE id = $1 RETURNING next_sequence - 1 AS seq",
      [template.id],
    )
    const seq = Number(rows[0][0] ? rows[0][0].seq : rows[0].seq)
    const candidate = `${numberPrefix}${String(seq).padStart(numberPadding, "0")}`.toUpperCase()
    const taken = await manager.getRepository("Document").findOne({
      where: { organizationId: template.organizationId, documentNo: candidate },
      select: ["id"],
    })
    if (!taken) return candidate
  }
  throw new Error("Couldn't find a free document number")
}

module.exports = {
  createTemplate,
  addVersion,
  getTemplate,
  getVersion,
  listTemplates,
  templateDetail,
  templateVersion,
  updateTemplate,
  nextDocumentNo,
  prepareVersion,
  uploadSource,
}

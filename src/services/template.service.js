const { AppDataSource, repo } = require("../config/database")
const { validateSchema, normalizeData } = require("../lib/schema")
const { checkTemplateSyntax } = require("../lib/render")
const { canonicalJson, sha256 } = require("../lib/crypto")
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

function prepareVersion({ html, schema, settings }) {
  if (typeof html !== "string" || !html.trim()) throw badRequest("Template HTML is required")
  if (html.length > MAX_HTML) throw badRequest("Template HTML is too large (max 1 MB)")
  checkTemplateSyntax(html)
  let parsed = schema
  if (typeof schema === "string") {
    try {
      parsed = JSON.parse(schema)
    } catch (err) {
      throw badRequest(`Field schema is not valid JSON: ${err.message}`)
    }
  }
  const cleanSchema = validateSchema(parsed)
  const cleanSet = cleanSettings(settings, cleanSchema)
  const { sampleData, ...hashedSettings } = cleanSet
  return {
    html,
    schema: cleanSchema,
    settings: cleanSet,
    contentHash: sha256(canonicalJson({ html, schema: cleanSchema, settings: hashedSettings })),
  }
}

async function createTemplate(user, { name, description, html, schema, settings }) {
  const title = String(name || "").trim()
  if (!title) throw badRequest("Template name is required")
  const version = prepareVersion({ html, schema, settings })
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
    return { template, version: v }
  })
}

async function addVersion(user, templateId, input) {
  const prepared = prepareVersion(input)
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
    return { template, version: v }
  })
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
async function nextDocumentNo(manager, template, version) {
  const rows = await manager.query(
    "UPDATE templates SET next_sequence = next_sequence + 1 WHERE id = $1 RETURNING next_sequence - 1 AS seq",
    [template.id],
  )
  const seq = Number(rows[0][0] ? rows[0][0].seq : rows[0].seq)
  const { numberPrefix = "", numberPadding = 4 } = version.settings || {}
  return `${numberPrefix}${String(seq).padStart(numberPadding, "0")}`
}

module.exports = { createTemplate, addVersion, getTemplate, getVersion, nextDocumentNo, prepareVersion }

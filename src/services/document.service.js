const { AppDataSource, repo } = require("../config/database")
const { normalizeData, verifyFields } = require("../lib/schema")
const { renderDocument, buildContext, qrDataUrl } = require("../lib/render")
const { htmlToPdf, imageToPng } = require("./pdf.service")
const { renderOverlay } = require("../lib/pdf-overlay")
const storage = require("./storage.service")
const { getTemplate, getVersion, nextDocumentNo } = require("./template.service")
const {
  canonicalJson, sha256, signPayload, verifyPayload, newPublicId, normalizePublicId, formatPublicId,
} = require("../lib/crypto")
const { audit } = require("../lib/audit")
const { badRequest, forbidden, notFound, conflict } = require("../lib/errors")

const DOC_NO_RE = /^[A-Za-z0-9][A-Za-z0-9/\-_. ]{0,119}$/

function cleanDocumentNo(value) {
  const v = String(value || "").trim().toUpperCase()
  if (!DOC_NO_RE.test(v)) throw badRequest("Document number may use letters, numbers, spaces and / - _ . (max 120)")
  return v
}

const canApprove = (user) => ["admin", "approver"].includes(user.role)
const canEditDraft = (user, doc) => user.role === "admin" || doc.createdBy === user.id

function baseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "")
}

async function lockDocument(m, orgId, id) {
  const doc = await m
    .getRepository("Document")
    .createQueryBuilder("d")
    .setLock("pessimistic_write")
    .where("d.id = :id AND d.organization_id = :org", { id, org: orgId })
    .getOne()
  if (!doc) throw notFound("Document not found")
  return doc
}

async function createDocument(req, { templateId, data, documentNo }) {
  const user = req.user
  const template = await getTemplate(user.organizationId, templateId)
  if (template.archived) throw badRequest("This template is archived")
  const version = await getVersion(user.organizationId, template.currentVersionId)
  const clean = normalizeData(version.schema, data)

  return AppDataSource.transaction(async (m) => {
    const no = documentNo ? cleanDocumentNo(documentNo) : await nextDocumentNo(m, template, version)
    const doc = await m.getRepository("Document").save({
      organizationId: user.organizationId,
      templateId: template.id,
      templateVersionId: version.id,
      documentNo: no,
      status: "draft",
      data: clean,
      createdBy: user.id,
    })
    await audit(req, "document.created", { entityType: "document", entityId: doc.id, details: { documentNo: no } }, m)
    return doc
  })
}

// Drafts aren't official yet, so they follow template changes: when a draft is
// saved or submitted it moves to the template's current version. (Documents
// awaiting approval keep the version the approver is looking at.)
async function moveToLatestVersion(doc) {
  const template = await getTemplate(doc.organizationId, doc.templateId)
  if (template.currentVersionId && template.currentVersionId !== doc.templateVersionId) {
    const latest = await getVersion(doc.organizationId, template.currentVersionId)
    doc.templateVersionId = latest.id
    doc.data = normalizeData(latest.schema, doc.data)
    return latest
  }
  return getVersion(doc.organizationId, doc.templateVersionId)
}

async function updateDraft(req, id, { data, documentNo }) {
  const user = req.user
  return AppDataSource.transaction(async (m) => {
    const doc = await lockDocument(m, user.organizationId, id)
    if (doc.status !== "draft") throw conflict("Only drafts can be edited. Issued documents are locked — create a correction instead.")
    if (!canEditDraft(user, doc)) throw forbidden("Only the person who created this draft (or an admin) can edit it")
    const version = await moveToLatestVersion(doc)
    if (data !== undefined) doc.data = normalizeData(version.schema, data)
    if (documentNo !== undefined) doc.documentNo = cleanDocumentNo(documentNo)
    await m.getRepository("Document").save(doc)
    await audit(req, "document.updated", { entityType: "document", entityId: doc.id }, m)
    return doc
  })
}

async function deleteDraft(req, id) {
  const user = req.user
  return AppDataSource.transaction(async (m) => {
    const doc = await lockDocument(m, user.organizationId, id)
    if (doc.status !== "draft") throw conflict("Only drafts can be deleted")
    if (!canEditDraft(user, doc)) throw forbidden()
    await m.getRepository("Document").delete({ id: doc.id })
    await audit(req, "document.deleted", { entityType: "document", entityId: doc.id, details: { documentNo: doc.documentNo } }, m)
  })
}

async function submitForApproval(req, id) {
  const user = req.user
  return AppDataSource.transaction(async (m) => {
    const doc = await lockDocument(m, user.organizationId, id)
    if (doc.status !== "draft") throw conflict("Only drafts can be submitted")
    if (!canEditDraft(user, doc)) throw forbidden()
    const version = await moveToLatestVersion(doc)
    doc.data = normalizeData(version.schema, doc.data, { strict: true })
    doc.status = "pending_approval"
    doc.submittedAt = new Date()
    doc.reviewNote = null
    await m.getRepository("Document").save(doc)
    await audit(req, "document.submitted", { entityType: "document", entityId: doc.id }, m)
    return doc
  })
}

async function sendBack(req, id, { note }) {
  const user = req.user
  if (!canApprove(user)) throw forbidden()
  return AppDataSource.transaction(async (m) => {
    const doc = await lockDocument(m, user.organizationId, id)
    if (doc.status !== "pending_approval") throw conflict("Only documents awaiting approval can be sent back")
    doc.status = "draft"
    doc.reviewNote = String(note || "").slice(0, 2000) || null
    await m.getRepository("Document").save(doc)
    await audit(req, "document.sent_back", { entityType: "document", entityId: doc.id, details: { note: doc.reviewNote } }, m)
    return doc
  })
}

const personSnapshot = (u) => ({
  id: u.id,
  name: u.name,
  qualification: u.qualification || "",
  signature: u.signature || "",
})

// Approve and issue: lock the content, sign it, render the official PDF.
async function approveAndIssue(req, id) {
  const user = req.user
  if (!canApprove(user)) throw forbidden("Only approvers and admins can issue documents")

  return AppDataSource.transaction(async (m) => {
    const doc = await lockDocument(m, user.organizationId, id)
    if (!["pending_approval", "draft"].includes(doc.status)) throw conflict(`This document is already ${doc.status}`)
    const org = await m
      .getRepository("Organization")
      .createQueryBuilder("o")
      .addSelect("o.privateKeyEnc")
      .where("o.id = :id", { id: user.organizationId })
      .getOne()
    if (org.requireSeparateApprover && doc.createdBy === user.id) {
      throw forbidden("Someone other than the person who prepared this document must approve it")
    }
    // Another person's draft must be submitted before it can be approved.
    if (doc.status === "draft" && doc.createdBy !== user.id) {
      throw conflict("This draft hasn't been submitted for approval yet")
    }
    const version = await getVersion(user.organizationId, doc.templateVersionId)
    const template = await getTemplate(user.organizationId, doc.templateId)
    const data = normalizeData(version.schema, doc.data, { strict: true })
    const preparer = await m.getRepository("User").findOne({ where: { id: doc.createdBy } })

    let supersedes = null
    if (doc.supersedesId) {
      const previous = await lockDocument(m, user.organizationId, doc.supersedesId)
      if (previous.status !== "issued") throw conflict(`The document this corrects is ${previous.status}, not issued`)
      supersedes = { id: previous.id, documentNo: previous.documentNo, publicId: previous.publicId }
      previous.status = "superseded"
      previous.supersededById = doc.id
      await m.getRepository("Document").save(previous)
      await audit(req, "document.superseded", { entityType: "document", entityId: previous.id, details: { by: doc.documentNo } }, m)
    }

    const issuedAt = new Date()
    const publicId = newPublicId()
    const signedPayload = {
      v: 1,
      org: { id: org.id, name: org.name, slug: org.slug, keyId: org.keyId },
      documentId: doc.id,
      documentNo: doc.documentNo,
      publicId,
      template: { id: template.id, name: template.name, versionId: version.id, version: version.version, contentHash: version.contentHash },
      data,
      preparedBy: personSnapshot(preparer || { id: doc.createdBy, name: "Unknown" }),
      approvedBy: personSnapshot(user),
      issuedAt: issuedAt.toISOString(),
      supersedes,
    }
    const { contentHash, signature } = signPayload(signedPayload, org.privateKeyEnc)

    Object.assign(doc, {
      status: "issued",
      data,
      publicId,
      issuedAt,
      issuedBy: user.id,
      signedPayload,
      contentHash,
      signature,
      keyId: org.keyId,
      reviewNote: null,
    })

    const pdf = await toPdf(await renderIssued(req, doc, org, version))
    doc.pdfPath = await storage.savePdf(org.id, doc.id, pdf)
    doc.pdfHash = sha256(pdf)

    await m.getRepository("Document").save(doc)
    await audit(req, "document.issued", {
      entityType: "document",
      entityId: doc.id,
      details: { documentNo: doc.documentNo, contentHash, pdfHash: doc.pdfHash },
    }, m)
    return doc
  })
}

async function revoke(req, id, { reason }) {
  const user = req.user
  if (!canApprove(user)) throw forbidden("Only approvers and admins can revoke documents")
  const why = String(reason || "").trim()
  if (!why) throw badRequest("Give a reason for revoking — partners will see it")
  return AppDataSource.transaction(async (m) => {
    const doc = await lockDocument(m, user.organizationId, id)
    if (doc.status !== "issued") throw conflict("Only issued documents can be revoked")
    Object.assign(doc, { status: "revoked", revokedAt: new Date(), revokedBy: user.id, revokeReason: why.slice(0, 1000) })
    await m.getRepository("Document").save(doc)
    await audit(req, "document.revoked", { entityType: "document", entityId: doc.id, details: { reason: doc.revokeReason } }, m)
    return doc
  })
}

// Start a correction: a new draft that will replace an issued document once issued.
async function startCorrection(req, id) {
  const user = req.user
  return AppDataSource.transaction(async (m) => {
    const original = await lockDocument(m, user.organizationId, id)
    if (original.status !== "issued") throw conflict("Only issued documents can be corrected")
    const open = await m.getRepository("Document").findOne({ where: { supersedesId: original.id } })
    if (open) throw conflict(`A correction already exists (${open.documentNo})`)
    const template = await getTemplate(user.organizationId, original.templateId)
    const version = await getVersion(user.organizationId, template.currentVersionId)

    const base = original.documentNo.replace(/-R\d+$/, "")
    const rev = Number((original.documentNo.match(/-R(\d+)$/) || [0, 0])[1]) + 1
    const doc = await m.getRepository("Document").save({
      organizationId: user.organizationId,
      templateId: template.id,
      templateVersionId: version.id,
      documentNo: `${base}-R${rev}`,
      status: "draft",
      data: normalizeData(version.schema, original.data),
      createdBy: user.id,
      supersedesId: original.id,
    })
    await audit(req, "document.correction_started", { entityType: "document", entityId: doc.id, details: { corrects: original.documentNo } }, m)
    return doc
  })
}

// ---- Rendering -------------------------------------------------------------
// Every render returns { kind: "html" | "pdf", body }. HTML templates produce HTML
// (turned into a PDF by Chrome); PDF templates print straight onto the original.

const STAMPS = { draft: "DRAFT · NOT VALID", revoked: "REVOKED · NOT VALID", superseded: "SUPERSEDED · NOT VALID", preview: "PREVIEW · NOT VALID" }

async function renderOutput(p) {
  const { version } = p
  if (version.kind !== "pdf") return { kind: "html", body: await renderDocument(p) }

  const context = await buildContext(p)
  if (p.preview) {
    // Show every box filled so the admin can check positions.
    context.approvedBy = context.approvedBy || context.preparedBy
    context.qr = context.qr || (await qrDataUrl(`${p.baseUrl}/v/PREVIEW`))
    context.document.verificationCode = context.document.verificationCode || "PREV-IEW0-0000-0000-0000-0000"
    context.document.issuedAt = context.document.issuedAt || new Date().toISOString()
  }
  const source = await storage.readTemplateSource(p.org.id, version.sourceHash)
  if (sha256(source) !== version.sourceHash) throw new Error("Template PDF doesn't match its fingerprint")
  let stamp = p.stamp
  if (stamp === undefined) stamp = p.preview ? STAMPS.preview : context.isDraft ? STAMPS.draft : null
  const body = await renderOverlay({
    source,
    layout: version.layout,
    schema: version.schema,
    context,
    stamp,
    toPng: imageToPng,
  })
  return { kind: "pdf", body }
}

const toPdf = async (out) => (out.kind === "pdf" ? out.body : htmlToPdf(out.body))

// `stamp`: optional label across the page (used for revoked/superseded copies).
async function renderIssued(req, doc, org, version, { stamp } = {}) {
  const p = doc.signedPayload
  return renderOutput({
    version,
    data: p.data,
    org,
    document: { ...doc, status: "issued" },
    preparedBy: p.preparedBy,
    approvedBy: p.approvedBy,
    baseUrl: baseUrl(req),
    stamp: stamp === undefined ? null : stamp,
  })
}

async function renderForDashboard(req, doc) {
  const org = await repo("Organization").findOne({ where: { id: doc.organizationId } })
  if (doc.signedPayload) return renderIssued(req, doc, org, await getVersion(doc.organizationId, doc.templateVersionId))
  // Drafts preview with the latest template version (they move to it on save).
  const draft = { ...doc }
  const version = doc.status === "draft" ? await moveToLatestVersion(draft) : await getVersion(doc.organizationId, doc.templateVersionId)
  const preparer = await repo("User").findOne({ where: { id: doc.createdBy } })
  return renderOutput({ version, data: draft.data, org, document: draft, preparedBy: preparer, baseUrl: baseUrl(req) })
}

async function renderPreview(req, input) {
  const { prepareVersion } = require("./template.service")
  const version = await prepareVersion({ ...input, settings: {} }, req.user.organizationId)
  const org = await repo("Organization").findOne({ where: { id: req.user.organizationId } })
  return renderOutput({
    version: { ...version, id: null },
    data: normalizeData(version.schema, input.data || {}),
    org,
    document: { documentNo: "SAMPLE-0001", status: "draft" },
    preparedBy: req.user,
    approvedBy: req.user,
    baseUrl: baseUrl(req),
    preview: version.kind === "pdf",
  })
}

// ---- Public verification --------------------------------------------------

async function findForVerification(publicIdInput) {
  const publicId = normalizePublicId(publicIdInput)
  if (publicId.length < 16) return null
  const doc = await repo("Document").findOne({ where: { publicId } })
  if (!doc || !["issued", "revoked", "superseded"].includes(doc.status)) return null
  return doc
}

async function verificationReport(doc) {
  const org = await repo("Organization").findOne({ where: { id: doc.organizationId } })
  const version = await repo("TemplateVersion").findOne({ where: { id: doc.templateVersionId } })
  const p = doc.signedPayload || {}

  const signatureValid = Boolean(doc.signature) && p.org && p.org.keyId === org.keyId &&
    verifyPayload(p, doc.signature, org.publicKey)
  const hashMatches = sha256(Buffer.from(canonicalJson(p), "utf8")) === doc.contentHash
  const recordMatches =
    p.documentNo === doc.documentNo &&
    p.publicId === doc.publicId &&
    p.documentId === doc.id &&
    canonicalJson(p.data) === canonicalJson(doc.data) &&
    Boolean(version) && p.template && p.template.contentHash === version.contentHash
  let pdfMatches = false
  if (doc.pdfPath && doc.pdfHash) {
    try {
      pdfMatches = sha256(await storage.readFile(doc.pdfPath)) === doc.pdfHash
    } catch {
      pdfMatches = false
    }
  }
  const intact = signatureValid && hashMatches && recordMatches && pdfMatches

  let replacement = null
  if (doc.status === "superseded" && doc.supersededById) {
    const r = await repo("Document").findOne({ where: { id: doc.supersededById } })
    if (r && r.publicId) replacement = { documentNo: r.documentNo, publicId: r.publicId, status: r.status }
  }

  let verdict = doc.status === "issued" ? "valid" : doc.status
  if (!intact) verdict = "tampered"

  return {
    verdict, // valid | revoked | superseded | tampered
    status: doc.status,
    documentNo: doc.documentNo,
    verificationCode: formatPublicId(doc.publicId),
    publicId: doc.publicId,
    issuer: { name: org.name, slug: org.slug, keyId: org.keyId },
    templateName: p.template ? p.template.name : "",
    issuedAt: doc.issuedAt,
    preparedBy: p.preparedBy ? { name: p.preparedBy.name, qualification: p.preparedBy.qualification } : null,
    approvedBy: p.approvedBy ? { name: p.approvedBy.name, qualification: p.approvedBy.qualification } : null,
    revokedAt: doc.revokedAt,
    revokeReason: doc.revokeReason,
    replacement,
    fields: version ? verifyFields(version.schema, p.data || {}) : [],
    checks: { signatureValid, hashMatches, recordMatches, pdfMatches },
    contentHash: doc.contentHash,
    pdfHash: doc.pdfHash,
    signature: doc.signature,
    signedPayload: p,
  }
}

module.exports = {
  createDocument,
  updateDraft,
  deleteDraft,
  submitForApproval,
  sendBack,
  approveAndIssue,
  revoke,
  startCorrection,
  renderForDashboard,
  moveToLatestVersion,
  renderIssued,
  toPdf,
  STAMPS,
  renderPreview,
  findForVerification,
  verificationReport,
  baseUrl,
}

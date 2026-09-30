// Imports certificates from the old single-company version (the `certificates`
// table, or a JSON file) into a company on the platform, as signed, issued documents.
// Set LEGACY_ORG_SLUG afterwards so QR codes already printed (/report/<number>)
// redirect to the new verify page.
//
//   node scripts/import-legacy.js --org <company-slug> [--template <template-id>] [--file old.json] [--dry-run]
require("reflect-metadata")
const fs = require("fs")
const path = require("path")
const { AppDataSource, initializeDatabase, repo } = require("../src/config/database")
const { createTemplate, getVersion } = require("../src/services/template.service")
const { normalizeData } = require("../src/lib/schema")
const { signPayload, newPublicId } = require("../src/lib/crypto")
const { RENDER_PDF_JOB } = require("../src/services/document.service")
const { enqueue, runUntilIdle } = require("../src/services/jobs.service")
const { closeBrowser } = require("../src/services/pdf.service")
const { systemContext } = require("../src/lib/context")
const { isVerified, verifiedIdentity } = require("../src/services/org.service")

const SEED = path.join(__dirname, "..", "seeds", "lifting-inspection")
const LEGACY_TEMPLATE_NAME = "Report of Thorough Examination (LOLER)"

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// "21/01/2026" -> "2026-01-21" (so the template can format it); anything else unchanged.
function isoDate(value) {
  const m = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : String(value || "")
}

function imageFromPath(p) {
  if (!p) return ""
  if (p.startsWith("data:image/")) return p
  const abs = path.resolve(p)
  if (!fs.existsSync(abs)) return ""
  const ext = path.extname(abs).slice(1).replace("jpg", "jpeg")
  return `data:image/${ext};base64,${fs.readFileSync(abs).toString("base64")}`
}

function mapLegacy(p) {
  const reasons = p.reasons || {}
  return {
    documentNo: String(p.certificateNo || "").trim().toUpperCase(),
    data: {
      examDate: isoDate(p.examDate),
      reportDate: isoDate(p.reportDate),
      colorCode: p.colorCode || "",
      employerName: p.employerName || "",
      premisesAddress: p.premisesAddress || "",
      relevantStandard: p.relevantStandard || "",
      defectSheetAttached: Boolean(p.defectSheetAttached),
      reasonInstallation: Boolean(reasons.installation),
      reasonSixMonthly: Boolean(reasons.sixMonthly),
      reasonTwelveMonthly: Boolean(reasons.twelveMonthly),
      reasonWrittenScheme: Boolean(reasons.writtenScheme),
      reasonExceptional: Boolean(reasons.exceptional),
      items: (p.items || []).map(({ sn, ...item }) => item),
    },
    preparedBy: {
      id: null,
      name: (p.inspector && p.inspector.name) || "",
      qualification: (p.inspector && p.inspector.qualification) || "",
      signature: imageFromPath(p.inspector && p.inspector.signature),
    },
    approvedBy: {
      id: null,
      name: (p.checkedBy && p.checkedBy.name) || "",
      qualification: (p.checkedBy && p.checkedBy.qualification) || "",
      signature: imageFromPath(p.checkedBy && p.checkedBy.signature),
    },
  }
}

async function loadLegacyRows() {
  const file = arg("file")
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const list = Array.isArray(raw) ? raw : raw.certificates || raw.reports || [raw]
    return list.map((payload) => ({ payload, createdAt: new Date() }))
  }
  const exists = await AppDataSource.query("SELECT to_regclass('public.certificates') AS t")
  if (!exists[0].t) throw new Error("No `certificates` table found. Use --file to import from JSON.")
  const rows = await AppDataSource.query("SELECT payload, created_at FROM certificates ORDER BY certificate_no")
  return rows.map((r) => ({ payload: r.payload, createdAt: r.created_at }))
}

async function main() {
  const slug = arg("org")
  const dryRun = process.argv.includes("--dry-run")
  if (!slug) throw new Error("Pass --org <company-slug> (see Settings in the dashboard)")
  if (!process.env.PUBLIC_BASE_URL) throw new Error("Set PUBLIC_BASE_URL (e.g. https://verify.yourdomain.com) — it goes into the QR codes")

  await initializeDatabase()
  const org = await repo("Organization")
    .createQueryBuilder("o").addSelect("o.privateKeyEnc").where("o.slug = :slug", { slug }).getOne()
  if (!org) throw new Error(`No company with slug "${slug}"`)
  if (!dryRun && !isVerified(org)) throw new Error(`Verify the company first: npm run org -- verify ${slug} --by "Your name" ...`)
  const admin = await repo("User").findOne({ where: { organizationId: org.id, role: "admin" } })

  let template
  if (arg("template")) {
    template = await repo("Template").findOne({ where: { id: arg("template"), organizationId: org.id } })
    if (!template) throw new Error("Template not found in this company")
  } else {
    template = await repo("Template").findOne({ where: { organizationId: org.id, name: LEGACY_TEMPLATE_NAME } })
    if (!template && !dryRun) {
      ;({ template } = await createTemplate(systemContext({ user: admin, ip: "import-script" }), {
        name: LEGACY_TEMPLATE_NAME,
        description: "Imported from the previous certificate generator.",
        html: fs.readFileSync(path.join(SEED, "template.hbs"), "utf8"),
        schema: JSON.parse(fs.readFileSync(path.join(SEED, "schema.json"), "utf8")),
        settings: { numberPrefix: "", numberPadding: 4 },
      }))
      console.log(`Created template ${template.id}`)
    }
  }
  const version = template ? await getVersion(org.id, template.currentVersionId) : null
  const schema = version ? version.schema : JSON.parse(fs.readFileSync(path.join(SEED, "schema.json"), "utf8"))
  const baseUrl = new URL(process.env.PUBLIC_BASE_URL)

  const rows = await loadLegacyRows()
  let imported = 0
  let skipped = 0
  for (const row of rows) {
    const m = mapLegacy(row.payload)
    if (!m.documentNo) continue
    if (await repo("Document").findOne({ where: { organizationId: org.id, documentNo: m.documentNo } })) {
      console.log(`skip   ${m.documentNo} (already exists)`)
      skipped++
      continue
    }
    const data = normalizeData(schema, m.data)
    if (dryRun) {
      console.log(`ok     ${m.documentNo} (${data.items.length} items)`)
      continue
    }
    await AppDataSource.transaction(async (tx) => {
      const doc = await tx.getRepository("Document").save({
        organizationId: org.id, templateId: template.id, templateVersionId: version.id,
        documentNo: m.documentNo, status: "draft", data, createdBy: admin.id,
      })
      const issuedAt = new Date(row.createdAt || Date.now())
      const publicId = newPublicId()
      const signedPayload = {
        v: 2,
        org: { id: org.id, name: org.name, slug: org.slug, keyId: org.keyId, verified: verifiedIdentity(org) },
        documentId: doc.id,
        documentNo: doc.documentNo,
        publicId,
        template: { id: template.id, name: template.name, versionId: version.id, version: version.version, contentHash: version.contentHash },
        data,
        preparedBy: m.preparedBy,
        approvedBy: m.approvedBy,
        issuedAt: issuedAt.toISOString(),
        supersedes: null,
        imported: { from: "certificate-generator v1", importedAt: new Date().toISOString() },
      }
      const { contentHash, signature } = signPayload(signedPayload, org.privateKeyEnc)
      Object.assign(doc, {
        status: "issued", publicId, issuedAt, issuedBy: admin.id, signedPayload, contentHash, signature, keyId: org.keyId,
      })
      doc.pdfStatus = "pending"
      await tx.getRepository("Document").save(doc)
      await enqueue(tx, RENDER_PDF_JOB, { documentId: doc.id, organizationId: org.id, baseUrl: baseUrl.origin })
      await tx.getRepository("AuditEvent").insert({
        organizationId: org.id, action: "document.imported", entityType: "document", entityId: doc.id,
        details: { documentNo: doc.documentNo }, ip: "import-script",
      })
    })
    console.log(`import ${m.documentNo}`)
    imported++
  }
  if (imported) {
    console.log("\nMaking the PDFs…")
    await runUntilIdle()
  }
  console.log(`\nDone: ${imported} imported, ${skipped} skipped.`)
  if (imported) console.log(`Set LEGACY_ORG_SLUG=${slug} so old QR codes (/report/<number>) keep working.`)
}

main()
  .catch((err) => {
    console.error(err.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeBrowser()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

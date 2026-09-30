// Creates a demo company with three users and the lifting-inspection template,
// then issues one sample certificate.
//
//   npm run seed:demo
require("reflect-metadata")
const { In } = require("typeorm")
const fs = require("fs")
const path = require("path")
const { AppDataSource, initializeDatabase, pendingMigrations, repo } = require("../src/config/database")
const { createOrganizationWithAdmin, verifyOrganization } = require("../src/services/org.service")
const { createTemplate, uploadSource } = require("../src/services/template.service")
const documents = require("../src/services/document.service")
const { hashPassword, publicUser } = require("../src/lib/auth")
const { closeBrowser } = require("../src/services/pdf.service")
const { runUntilIdle } = require("../src/services/jobs.service")
const { systemContext } = require("../src/lib/context")

const DIR = path.join(__dirname, "..", "seeds", "lifting-inspection")
const PASSWORD = process.env.DEMO_PASSWORD || "demo-password-123"

const as = (user) => systemContext({ user, ip: "seed" })

async function main() {
  await initializeDatabase()
  if ((await pendingMigrations()).length) throw new Error("Run npm run db:migrate first")
  if (await repo("User").findOne({ where: { email: "admin@demo.test" } })) {
    console.log("Demo company already exists. Sign in as admin@demo.test")
    return
  }

  const { organization, user: admin } = await createOrganizationWithAdmin({
    orgName: "Demo Inspection Services",
    name: "Demo Admin",
    email: "admin@demo.test",
    password: PASSWORD,
  })
  const logo = path.join(__dirname, "..", "public", "images", "logo.png")
  if (fs.existsSync(logo) && fs.statSync(logo).size < 500_000) {
    organization.logo = `data:image/png;base64,${fs.readFileSync(logo).toString("base64")}`
    await repo("Organization").save(organization)
  }
  // Real companies are verified by platform staff (npm run org -- verify); the demo one is pre-verified.
  await verifyOrganization(organization.slug, {
    by: "demo seed",
    legalName: "Demo Inspection Services Ltd",
    registrationNumber: "DEMO-0001",
    registrationCountry: "NG",
    domain: "demo.example",
    trustDomain: true,
  })

  const passwordHash = await hashPassword(PASSWORD)
  const signature = (initials) =>
    `data:image/svg+xml;base64,${Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><path d="M10 45 C 40 5, 60 60, 90 25 S 140 50, 190 15" stroke="#1d3b8a" stroke-width="3" fill="none"/><text x="120" y="55" font-family="cursive" font-size="16" fill="#1d3b8a">${initials}</text></svg>`,
    ).toString("base64")}`
  const [issuer, approver] = await repo("User").save([
    {
      organizationId: organization.id, email: "inspector@demo.test", name: "Demo Inspector", role: "issuer",
      qualification: "ASNT Level II, IADC Lifting Inspector", passwordHash,
    },
    {
      organizationId: organization.id, email: "approver@demo.test", name: "Demo Approver", role: "approver",
      qualification: "LEEA Diploma", passwordHash,
    },
  ])
  // SVG signatures aren't accepted from uploads (they can carry scripts); these fixed
  // demo ones are generated here and rendered as images only.
  issuer.signature = signature("DI")
  approver.signature = signature("DA")
  await repo("User").save([issuer, approver])

  const sample = JSON.parse(fs.readFileSync(path.join(DIR, "sample.json"), "utf8"))
  const { template } = await createTemplate(as(admin), {
    name: "Report of Thorough Examination (LOLER)",
    description: "Lifting equipment / fall protection inspection report. Ten items per page.",
    html: fs.readFileSync(path.join(DIR, "template.hbs"), "utf8"),
    schema: JSON.parse(fs.readFileSync(path.join(DIR, "schema.json"), "utf8")),
    settings: { numberPrefix: "DEMO/LOLER-", numberPadding: 4, sampleData: sample },
  })

  const draft = await documents.createDocument(as(issuer), { templateId: template.id, data: sample })
  await documents.submitForApproval(as(issuer), draft.id)
  const issued = await documents.approveAndIssue(as(approver), draft.id)

  console.log("\nDemo company created. Sign in at /app with any of these (password: %s):", PASSWORD)
  for (const u of [admin, issuer, approver]) console.log(`  ${publicUser(u).role.padEnd(8)} ${u.email}`)
  if (issued) console.log(`\nSample certificate ${issued.documentNo}: /v/${issued.publicId}`)

  // A second template made from an uploaded PDF form, with boxes placed on it.
  const PT = path.join(__dirname, "..", "seeds", "pressure-test")
  const pt = JSON.parse(fs.readFileSync(path.join(PT, "template.json"), "utf8"))
  const { sourceHash } = await uploadSource(as(admin), fs.readFileSync(path.join(PT, "form.pdf")))
  const { template: ptTemplate } = await createTemplate(as(admin), { ...pt, kind: "pdf", sourceHash })
  const ptData = { ...pt.settings.sampleData }
  // 15 items: more than fit on the page, so the page repeats for the rest.
  ptData.items = Array.from({ length: 15 }, (_, i) => ({
    ...pt.settings.sampleData.items[i % pt.settings.sampleData.items.length],
    tag: `FL-${101 + i}`,
  }))
  const ptDraft = await documents.createDocument(as(issuer), { templateId: ptTemplate.id, data: ptData })
  await documents.submitForApproval(as(issuer), ptDraft.id)
  const ptIssued = await documents.approveAndIssue(as(approver), ptDraft.id)
  console.log(`Sample pressure test certificate (from a PDF form) ${ptIssued.documentNo}: /v/${ptIssued.publicId}`)

  // The official PDFs are made by background jobs; make them now.
  await runUntilIdle()
  const notReady = await repo("Document").count({ where: { organizationId: organization.id, pdfStatus: In(["pending", "failed"]) } })
  if (notReady) console.warn(`\n${notReady} PDF(s) couldn't be made yet — is Chrome available for Puppeteer? The server retries them; see the jobs table.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeBrowser()
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

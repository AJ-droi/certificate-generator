// Creates a demo company with three users and the lifting-inspection template,
// then issues one sample certificate.
//
//   npm run seed:demo
require("reflect-metadata")
const fs = require("fs")
const path = require("path")
const { AppDataSource, initializeDatabase, repo } = require("../src/config/database")
const { createOrganizationWithAdmin } = require("../src/services/org.service")
const { createTemplate } = require("../src/services/template.service")
const documents = require("../src/services/document.service")
const { hashPassword, publicUser } = require("../src/lib/auth")
const { closeBrowser } = require("../src/services/pdf.service")

const DIR = path.join(__dirname, "..", "seeds", "lifting-inspection")
const PASSWORD = process.env.DEMO_PASSWORD || "demo-password-123"

function fakeReq(user) {
  const base = new URL(process.env.PUBLIC_BASE_URL || "http://localhost:3100")
  return { user, ip: "seed", protocol: base.protocol.replace(":", ""), get: () => base.host }
}

async function main() {
  await initializeDatabase()
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
  const { template } = await createTemplate(admin, {
    name: "Report of Thorough Examination (LOLER)",
    description: "Lifting equipment / fall protection inspection report. Ten items per page.",
    html: fs.readFileSync(path.join(DIR, "template.hbs"), "utf8"),
    schema: JSON.parse(fs.readFileSync(path.join(DIR, "schema.json"), "utf8")),
    settings: { numberPrefix: "DEMO/LOLER-", numberPadding: 4, sampleData: sample },
  })

  const draft = await documents.createDocument(fakeReq(issuer), { templateId: template.id, data: sample })
  await documents.submitForApproval(fakeReq(issuer), draft.id)
  let issued = null
  try {
    issued = await documents.approveAndIssue(fakeReq(approver), draft.id)
  } catch (err) {
    console.warn(`Couldn't issue the sample (is Chrome available for Puppeteer?): ${err.message}`)
  }

  console.log("\nDemo company created. Sign in at /app with any of these (password: %s):", PASSWORD)
  for (const u of [admin, issuer, approver]) console.log(`  ${publicUser(u).role.padEnd(8)} ${u.email}`)
  if (issued) console.log(`\nSample certificate ${issued.documentNo}: /v/${issued.publicId}`)
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

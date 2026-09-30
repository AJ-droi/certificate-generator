// Platform staff: review and verify companies. A company can't issue documents
// until it's verified here. Needs server access (database + APP_SECRET), so it
// isn't reachable from the web.
//
//   npm run org -- list [--status pending|unverified|verified|rejected|suspended|all]
//   npm run org -- show <company-id>
//   npm run org -- verify <company-id> --by "Your name" [--legal-name ...] [--registration ...]
//                                     [--country NG] [--domain example.com] [--trust-domain]
//   npm run org -- reject <company-id> --by "Your name" --reason "..."
//   npm run org -- suspend <company-id> --by "Your name" --reason "..."
//
// Before verifying, check the registration number and name against the official
// registry (e.g. the CAC search in Nigeria) and that the person who asked works there.
require("reflect-metadata")
const { AppDataSource, initializeDatabase, repo } = require("../src/config/database")
const orgs = require("../src/services/org.service")

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)
const VALUE_FLAGS = ["--by", "--legal-name", "--registration", "--country", "--domain", "--reason", "--status"]
// Words that aren't flags or flag values: the command and the company ID.
const positional = () => process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !VALUE_FLAGS.includes(all[i - 1]))

const when = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—")

async function show(slug) {
  const org = await repo("Organization").findOne({ where: { slug } })
  if (!org) throw new Error(`No company with ID "${slug}"`)
  const admins = await repo("User").find({ where: { organizationId: org.id, role: "admin" } })
  const issued = await repo("Document").count({ where: { organizationId: org.id, status: "issued" } })
  const record = org.domain && org.domainToken ? `_docverify.${org.domain}  TXT  "docverify=${org.domainToken}"` : "—"
  console.log(`
${org.name}  (${org.slug})
  Status              ${org.verificationStatus}${org.verificationNote ? ` — ${org.verificationNote}` : ""}
  Signed up           ${when(org.createdAt)}
  Requested           ${when(org.verificationRequestedAt)}
  Registered name     ${org.legalName || "—"}
  Registration no.    ${org.registrationNumber || "—"} ${org.registrationCountry ? `(${org.registrationCountry})` : ""}
  Domain              ${org.domain || "—"}  ${org.domainVerifiedAt ? `✓ proven ${when(org.domainVerifiedAt)}` : "✕ not proven"}
  DNS record          ${record}
  Verified            ${org.verifiedAt ? `${when(org.verifiedAt)} by ${org.verifiedBy}` : "—"}
  Issued documents    ${issued}
  Admins              ${admins.map((u) => `${u.name} <${u.email}>`).join(", ") || "—"}`)

  const mismatched = org.domain ? admins.filter((u) => !u.email.endsWith(`@${org.domain}`) && !u.email.endsWith(`.${org.domain}`)) : []
  if (mismatched.length) console.log(`\n  ! Admin email not on ${org.domain}: ${mismatched.map((u) => u.email).join(", ")}`)
  const similar = await orgs.similarOrganizations(org)
  if (similar.length) {
    console.log("\n  ! Name looks like verified companies — check this isn't an impersonation:")
    for (const o of similar) console.log(`      ${o.legalName || o.name} (${o.slug}, ${o.domain})`)
  }
  console.log()
}

async function list(status) {
  const where = status === "all" ? {} : { verificationStatus: status }
  const rows = await repo("Organization").find({ where, order: { verificationRequestedAt: "ASC", createdAt: "ASC" } })
  if (!rows.length) return console.log(`No companies with status "${status}".`)
  for (const o of rows) {
    console.log(
      [o.verificationStatus.padEnd(10), o.slug.padEnd(32), (o.legalName || o.name).padEnd(40), o.domain || "", o.domainVerifiedAt ? "(dns ✓)" : ""].join(" "),
    )
  }
}

async function main() {
  const [command, slug] = positional()
  await initializeDatabase()
  switch (command) {
    case "list":
      return list(arg("status") || "pending")
    case "show":
      return show(slug)
    case "verify": {
      const org = await orgs.verifyOrganization(slug, {
        by: arg("by"),
        legalName: arg("legal-name"),
        registrationNumber: arg("registration"),
        registrationCountry: arg("country"),
        domain: arg("domain"),
        trustDomain: flag("trust-domain"),
      })
      console.log(`Verified ${org.legalName} (${org.slug}, ${org.domain}). It can now issue documents.`)
      return
    }
    case "reject": {
      await orgs.rejectOrganization(slug, { by: arg("by"), reason: arg("reason") })
      console.log(`Rejected ${slug}. The company sees the reason and can correct its details and ask again.`)
      return
    }
    case "suspend": {
      const org = await orgs.suspendOrganization(slug, { by: arg("by"), reason: arg("reason") })
      console.log(`Suspended ${org.slug}. It can't issue, and every document it issued now shows as not valid.`)
      return
    }
    default:
      console.log("Usage: npm run org -- list|show|verify|reject|suspend <company-id> [options] (see scripts/org-verification.js)")
      process.exitCode = 1
  }
}

main()
  .catch((err) => {
    console.error(err.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    if (AppDataSource.isInitialized) await AppDataSource.destroy()
  })

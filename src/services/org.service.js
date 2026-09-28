const { AppDataSource, repo } = require("../config/database")
const { generateSigningKey } = require("../lib/crypto")
const { hashPassword, validatePassword } = require("../lib/auth")
const { badRequest, conflict } = require("../lib/errors")
const crypto = require("crypto")

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "company"
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase()
  if (!EMAIL_RE.test(e) || e.length > 254) throw badRequest("Enter a valid email address")
  return e
}

function cleanName(value, label, max = 200) {
  const v = String(value || "").trim()
  if (!v) throw badRequest(`${label} is required`)
  return v.slice(0, max)
}

async function createOrganizationWithAdmin({ orgName, name, email, password }) {
  const org = cleanName(orgName, "Company name")
  const person = cleanName(name, "Your name")
  const mail = normalizeEmail(email)
  validatePassword(password)

  if (await repo("User").findOne({ where: { email: mail } })) {
    throw conflict("An account with this email already exists")
  }

  let slug = slugify(org)
  if (await repo("Organization").findOne({ where: { slug } })) {
    slug = `${slug}-${crypto.randomBytes(3).toString("hex")}`
  }

  const passwordHash = await hashPassword(password)
  return AppDataSource.transaction(async (m) => {
    const organization = await m.getRepository("Organization").save({
      name: org,
      slug,
      ...generateSigningKey(),
    })
    const user = await m.getRepository("User").save({
      organizationId: organization.id,
      email: mail,
      name: person,
      role: "admin",
      passwordHash,
    })
    return { organization, user }
  })
}

const publicOrg = (o) =>
  o && {
    id: o.id,
    name: o.name,
    slug: o.slug,
    logo: o.logo || null,
    requireSeparateApprover: o.requireSeparateApprover,
    keyId: o.keyId,
    publicKey: o.publicKey,
  }

module.exports = { createOrganizationWithAdmin, normalizeEmail, cleanName, publicOrg, slugify }

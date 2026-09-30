const { AppDataSource, repo } = require("../config/database")
const { generateSigningKey } = require("../lib/crypto")
const { hashPassword, validatePassword } = require("../lib/auth")
const { badRequest, conflict, notFound } = require("../lib/errors")
const { audit } = require("../lib/audit")
const { cleanImage } = require("../lib/validate")
const crypto = require("crypto")
const dns = require("dns")

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

// ---- Company verification ---------------------------------------------------------
// A company proves who it is before it can issue documents: it sends its legal
// name, registration number and website domain, proves it controls the domain
// with a DNS TXT record, and platform staff check the registration and approve
// it (scripts/org-verification.js). Verified details are locked and shown to
// partners on the verify page, so nobody can issue as "Shell" by signing up as it.

const DNS_PREFIX = "_docverify"
const TXT_PREFIX = "docverify="
// Replaceable in tests.
const dnsLookup = { resolveTxt: (name) => dns.promises.resolveTxt(name) }

const isVerified = (org) => Boolean(org) && org.verificationStatus === "verified"
const LOCKED_STATUSES = ["verified", "suspended"]

function normalizeDomain(input) {
  let v = String(input || "").trim().toLowerCase()
  if (!v) throw badRequest("Website domain is required")
  if (!/^[a-z]+:\/\//.test(v)) v = `https://${v}`
  let host
  try {
    host = new URL(v).hostname // also converts international names to punycode
  } catch {
    throw badRequest("Enter a domain like example.com")
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "")
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) {
    throw badRequest("Enter a domain like example.com")
  }
  return host
}

const dnsRecord = (org) =>
  org.domain && org.domainToken ? { name: `${DNS_PREFIX}.${org.domain}`, type: "TXT", value: `${TXT_PREFIX}${org.domainToken}` } : null

async function loadOrg(orgId) {
  const org = await repo("Organization").findOne({ where: { id: orgId } })
  if (!org) throw notFound("Company not found")
  return org
}

async function domainTakenByAnother(org, domain) {
  const other = await repo("Organization")
    .createQueryBuilder("o")
    .where("o.domain = :domain AND o.id <> :id AND o.domain_verified_at IS NOT NULL", { domain, id: org.id })
    .getOne()
  return Boolean(other)
}

// Company admin: send (or update) the details staff will check.
async function requestVerification(ctx, { legalName, registrationNumber, registrationCountry, domain }) {
  const org = await loadOrg(ctx.user.organizationId)
  if (LOCKED_STATUSES.includes(org.verificationStatus)) {
    throw conflict("Your company's verified details are locked. Contact support to change them.")
  }
  const country = String(registrationCountry || "").trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) throw badRequest("Choose the country the company is registered in")
  const host = normalizeDomain(domain)
  if (await domainTakenByAnother(org, host)) throw conflict("Another company has already verified this domain")

  org.legalName = cleanName(legalName, "Registered company name")
  org.registrationNumber = cleanName(registrationNumber, "Registration number", 100)
  org.registrationCountry = country
  if (org.domain !== host || !org.domainToken) {
    org.domain = host
    org.domainToken = crypto.randomBytes(16).toString("hex")
    org.domainVerifiedAt = null
  }
  org.verificationStatus = "pending"
  org.verificationRequestedAt = new Date()
  org.verificationNote = null
  await repo("Organization").save(org)
  await audit(ctx, "organization.verification_requested", {
    entityType: "organization",
    entityId: org.id,
    details: { legalName: org.legalName, registrationNumber: org.registrationNumber, registrationCountry: country, domain: host },
  })
  return org
}

// Looks up the TXT record that proves the company controls its domain, and
// records it if found.
async function lookupDomainProof(org) {
  const record = dnsRecord(org)
  if (!record) throw badRequest("Request verification with your website domain first")
  if (org.domainVerifiedAt) return true
  let values
  try {
    values = (await dnsLookup.resolveTxt(record.name)).map((chunks) => chunks.join(""))
  } catch {
    values = []
  }
  if (!values.includes(record.value)) return false
  if (await domainTakenByAnother(org, org.domain)) throw conflict("Another company has already verified this domain")
  org.domainVerifiedAt = new Date()
  await repo("Organization").save(org)
  return true
}

// Company admin: check their DNS record.
async function checkDomain(ctx) {
  const org = await loadOrg(ctx.user.organizationId)
  const already = Boolean(org.domainVerifiedAt)
  const found = await lookupDomainProof(org)
  if (!already) {
    await audit(ctx, found ? "organization.domain_verified" : "organization.domain_check_failed", {
      entityType: "organization",
      entityId: org.id,
      details: { domain: org.domain },
    })
  }
  return { org, found }
}

// Company admin: name, logo, four-eyes approval.
async function updateOrgSettings(ctx, { name, logo, requireSeparateApprover } = {}) {
  const org = await loadOrg(ctx.user.organizationId)
  if (name !== undefined) {
    const clean = cleanName(name, "Company name")
    // Documents and the verify page carry the verified name, so it can't drift.
    if (clean !== org.name && LOCKED_STATUSES.includes(org.verificationStatus)) {
      throw conflict("The company name is locked once the company is verified. Contact support to change it.")
    }
    org.name = clean
  }
  if (logo !== undefined) org.logo = cleanImage(logo, "Logo")
  if (requireSeparateApprover !== undefined) org.requireSeparateApprover = Boolean(requireSeparateApprover)
  await repo("Organization").save(org)
  await audit(ctx, "organization.updated", {
    entityType: "organization",
    entityId: org.id,
    details: { name: org.name, requireSeparateApprover: org.requireSeparateApprover, logoChanged: logo !== undefined },
  })
  return org
}

// ---- Platform staff (the /platform dashboard, or scripts/org-verification.js) ----------
// `by` is the staff member: { id, name } from the dashboard, or a name typed on the
// server's command line. It's recorded with every action.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Companies are addressed by ID in the dashboard and by slug on the command line.
async function findOrg(ref) {
  const key = String(ref || "")
  const org = await repo("Organization").findOne({ where: UUID_RE.test(key) ? { id: key } : { slug: key } })
  if (!org) throw notFound(`No company with ID "${key}"`)
  return org
}

function staffOf(by) {
  const name = String((by && typeof by === "object" ? by.name : by) || "").trim()
  if (!name) throw badRequest("Say who is doing this (--by \"Your name\")")
  return { staff: name.slice(0, 200), staffId: by && typeof by === "object" ? by.id : null }
}

const staffAudit = (org, action, who, details = {}) =>
  audit(null, action, { organizationId: org.id, entityType: "organization", entityId: org.id, details: { ...who, ...details } })

// Staff: check the company's DNS record now.
async function staffCheckDomain(ref, by) {
  const who = staffOf(by)
  const org = await findOrg(ref)
  const already = Boolean(org.domainVerifiedAt)
  const found = await lookupDomainProof(org)
  if (!already) await staffAudit(org, found ? "organization.domain_verified" : "organization.domain_check_failed", who, { domain: org.domain })
  return { org, found }
}

// Staff have checked the registration with the registry. `overrides` lets staff
// correct or supply details (e.g. when onboarding a company themselves);
// `trustDomain` records that staff confirmed the domain some other way.
async function verifyOrganization(ref, { by, trustDomain = false, registryChecked = false, ...overrides } = {}) {
  const who = staffOf(by)
  const org = await findOrg(ref)
  if (overrides.legalName) org.legalName = cleanName(overrides.legalName, "Registered company name")
  if (overrides.registrationNumber) org.registrationNumber = cleanName(overrides.registrationNumber, "Registration number", 100)
  if (overrides.registrationCountry) {
    const c = String(overrides.registrationCountry).trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(c)) throw badRequest("Country must be a two-letter code, e.g. NG")
    org.registrationCountry = c
  }
  if (overrides.domain) {
    const host = normalizeDomain(overrides.domain)
    if (host !== org.domain) {
      org.domain = host
      org.domainToken = crypto.randomBytes(16).toString("hex")
      org.domainVerifiedAt = null
    }
  }
  if (!org.legalName || !org.registrationNumber || !org.registrationCountry || !org.domain) {
    throw badRequest("Registered name, registration number, country and domain are all needed to verify a company")
  }
  if (await domainTakenByAnother(org, org.domain)) throw conflict(`Another company has already verified ${org.domain}`)
  if (!org.domainVerifiedAt) {
    if (!trustDomain) throw badRequest(`${org.domain} hasn't been proven with its DNS record yet (use --trust-domain if you confirmed it another way)`)
    org.domainVerifiedAt = new Date()
  }
  const reinstated = org.verificationStatus === "suspended"
  Object.assign(org, { verificationStatus: "verified", verifiedAt: new Date(), verifiedBy: who.staff, verificationNote: null })
  await repo("Organization").save(org)
  await staffAudit(org, reinstated ? "organization.reinstated" : "organization.verified", who, {
    legalName: org.legalName,
    registrationNumber: org.registrationNumber,
    registrationCountry: org.registrationCountry,
    domain: org.domain,
    domainTrustedByStaff: Boolean(trustDomain),
    registryChecked: Boolean(registryChecked),
  })
  return org
}

async function rejectOrganization(ref, { by, reason }) {
  const who = staffOf(by)
  const why = cleanName(reason, "Reason", 1000)
  const org = await findOrg(ref)
  if (LOCKED_STATUSES.includes(org.verificationStatus)) throw conflict(`This company is ${org.verificationStatus} — suspend it instead`)
  Object.assign(org, { verificationStatus: "rejected", verificationNote: why })
  await repo("Organization").save(org)
  await staffAudit(org, "organization.verification_rejected", who, { reason: why })
  return org
}

// Stops a company issuing, and makes the verify page warn about everything it issued.
async function suspendOrganization(ref, { by, reason }) {
  const who = staffOf(by)
  const why = cleanName(reason, "Reason", 1000)
  const org = await findOrg(ref)
  if (org.verificationStatus !== "verified") throw conflict("Only verified companies can be suspended — reject the request instead")
  Object.assign(org, { verificationStatus: "suspended", verificationNote: why })
  await repo("Organization").save(org)
  await staffAudit(org, "organization.suspended", who, { reason: why })
  return org
}

// Names that look alike once legal suffixes, punctuation and look-alike
// characters are ignored ("Shell Nig. Ltd", "SHELL NIGERIA LIMITED", "She1l").
const SUFFIXES = /\b(ltd|limited|plc|inc|incorporated|llc|llp|co|company|corp|corporation|group|holdings|nig|nigeria|the)\b/g
function nameKey(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9|!$\s]/g, " ")
    // Legal suffixes first, before look-alike swaps change their spelling.
    .replace(SUFFIXES, " ")
    .replace(/0/g, "o")
    .replace(/[1|!i]/g, "l")
    .replace(/[5$]/g, "s")
    .replace(/[^a-z]/g, "")
}

async function similarOrganizations(org) {
  const keys = [nameKey(org.name), nameKey(org.legalName)].filter((k) => k.length >= 3)
  if (!keys.length) return []
  const others = await repo("Organization").find({ where: { verificationStatus: "verified" } })
  return others.filter((o) => {
    if (o.id === org.id) return false
    const theirs = [nameKey(o.name), nameKey(o.legalName)].filter((k) => k.length >= 3)
    return theirs.some((t) => keys.some((k) => t === k || t.includes(k) || k.includes(t)))
  })
}

// What's signed into each document and shown to partners.
const verifiedIdentity = (org) =>
  isVerified(org)
    ? { legalName: org.legalName, registrationNumber: org.registrationNumber, registrationCountry: org.registrationCountry, domain: org.domain }
    : null

const publicOrg = (o) =>
  o && {
    id: o.id,
    name: o.name,
    slug: o.slug,
    logo: o.logo || null,
    requireSeparateApprover: o.requireSeparateApprover,
    keyId: o.keyId,
    publicKey: o.publicKey,
    verification: {
      status: o.verificationStatus,
      legalName: o.legalName || null,
      registrationNumber: o.registrationNumber || null,
      registrationCountry: o.registrationCountry || null,
      domain: o.domain || null,
      domainVerified: Boolean(o.domainVerifiedAt),
      dnsRecord: dnsRecord(o),
      requestedAt: o.verificationRequestedAt || null,
      verifiedAt: o.verifiedAt || null,
      note: o.verificationNote || null,
    },
  }

module.exports = {
  createOrganizationWithAdmin,
  normalizeEmail,
  cleanName,
  publicOrg,
  slugify,
  dnsLookup,
  isVerified,
  normalizeDomain,
  requestVerification,
  updateOrgSettings,
  loadOrg,
  checkDomain,
  staffCheckDomain,
  findOrg,
  dnsRecord,
  verifyOrganization,
  rejectOrganization,
  suspendOrganization,
  similarOrganizations,
  nameKey,
  verifiedIdentity,
  LOCKED_STATUSES,
}

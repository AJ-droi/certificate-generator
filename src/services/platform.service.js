// Platform staff: accounts, sign-in with an authenticator app, and the numbers
// behind the /platform dashboard.
const { AppDataSource, repo } = require("../config/database")
const { hashPassword, checkPassword, validatePassword } = require("../lib/auth")
const { encrypt, decrypt, randomPassword } = require("../lib/crypto")
const totp = require("../lib/totp")
const { audit } = require("../lib/audit")
const { HttpError, badRequest, conflict, notFound } = require("../lib/errors")
const { normalizeEmail, cleanName, similarOrganizations, findOrg, publicOrg } = require("./org.service")
const { APP_NAME } = require("../views/html")

const staffAudit = (staff, action, details = {}) =>
  audit(null, action, { entityType: "platform_admin", entityId: staff && staff.id, details: { staff: staff && staff.name, staffId: staff && staff.id, ...details } })

const withSecrets = (where) =>
  repo("PlatformAdmin").createQueryBuilder("p").addSelect(["p.passwordHash", "p.totpSecretEnc"]).where(where.sql, where.params).getOne()

// ---- Accounts (created and reset from the server only: scripts/platform-staff.js) ----

async function createStaff({ email, name }) {
  const mail = normalizeEmail(email)
  if (await repo("PlatformAdmin").findOne({ where: { email: mail } })) throw conflict("A staff account with this email already exists")
  const temporaryPassword = randomPassword()
  const staff = await repo("PlatformAdmin").save({
    email: mail,
    name: cleanName(name, "Name"),
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
  })
  await staffAudit(staff, "platform.staff_created", { email: mail, via: "server" })
  return { staff, temporaryPassword }
}

// New temporary password and authenticator app; signs out everywhere.
async function resetStaff(email) {
  const staff = await repo("PlatformAdmin").findOne({ where: { email: normalizeEmail(email) } })
  if (!staff) throw notFound("No staff account with that email")
  const temporaryPassword = randomPassword()
  Object.assign(staff, {
    passwordHash: await hashPassword(temporaryPassword),
    totpSecretEnc: null,
    totpEnabled: false,
    totpLastStep: 0,
    mustChangePassword: true,
    active: true,
    tokenVersion: staff.tokenVersion + 1,
  })
  await repo("PlatformAdmin").save(staff)
  await staffAudit(staff, "platform.staff_reset", { via: "server" })
  return { staff, temporaryPassword }
}

async function setStaffActive(email, active) {
  const staff = await repo("PlatformAdmin").findOne({ where: { email: normalizeEmail(email) } })
  if (!staff) throw notFound("No staff account with that email")
  staff.active = Boolean(active)
  if (!staff.active) staff.tokenVersion += 1
  await repo("PlatformAdmin").save(staff)
  await staffAudit(staff, active ? "platform.staff_enabled" : "platform.staff_disabled", { via: "server" })
  return staff
}

// ---- Sign-in ------------------------------------------------------------------------

const BAD_LOGIN = "Email, password or code is incorrect"

// Returns { staff, mfa }. mfa=false means the account still has to set up its
// authenticator app (and new password) before it can do anything.
async function login({ email, password, code }, ip) {
  let mail
  try {
    mail = normalizeEmail(email)
  } catch {
    throw new HttpError(401, BAD_LOGIN)
  }
  const staff = await withSecrets({ sql: "p.email = :mail", params: { mail } })
  const ok = staff && staff.active && (await checkPassword(String(password || ""), staff.passwordHash))
  if (!ok) {
    if (staff) await audit({ ip }, "platform.login_failed", { entityType: "platform_admin", entityId: staff.id, details: { staff: staff.name, staffId: staff.id } })
    throw new HttpError(401, BAD_LOGIN)
  }
  if (!staff.totpEnabled) return { staff, mfa: false }
  if (!code) throw new HttpError(401, "Enter the code from your authenticator app", { code: "code_required" })
  const step = totp.verifyCode(decrypt(staff.totpSecretEnc), code, staff.totpLastStep)
  if (step === null) {
    await audit({ ip }, "platform.login_failed", { entityType: "platform_admin", entityId: staff.id, details: { staff: staff.name, staffId: staff.id, reason: "code" } })
    throw new HttpError(401, BAD_LOGIN)
  }
  staff.totpLastStep = step
  staff.lastLoginAt = new Date()
  await repo("PlatformAdmin").save(staff)
  await audit({ ip }, "platform.login", { entityType: "platform_admin", entityId: staff.id, details: { staff: staff.name, staffId: staff.id } })
  return { staff, mfa: true }
}

// Starts authenticator setup: a new secret, shown once as a QR code.
async function startMfaSetup(staff) {
  if (staff.totpEnabled) throw conflict("Your authenticator app is already set up")
  const secret = totp.newSecret()
  await repo("PlatformAdmin").update({ id: staff.id }, { totpSecretEnc: encrypt(secret) })
  return { secret, otpauthUrl: totp.otpauthUrl({ secret, account: staff.email, issuer: `${APP_NAME()} staff` }) }
}

// Finishes setup: a code from the app proves it was scanned; a temporary
// password is replaced at the same time.
async function finishMfaSetup(staff, { code, newPassword }, ip) {
  if (staff.totpEnabled) throw conflict("Your authenticator app is already set up")
  const full = await withSecrets({ sql: "p.id = :id", params: { id: staff.id } })
  if (!full.totpSecretEnc) throw badRequest("Start the setup again")
  const step = totp.verifyCode(decrypt(full.totpSecretEnc), code, full.totpLastStep)
  if (step === null) throw badRequest("That code doesn't match. Check the time on your phone and try the next code.")
  if (full.mustChangePassword) {
    validatePassword(newPassword)
    if (String(newPassword).length < 12) throw badRequest("Staff passwords must be at least 12 characters")
    full.passwordHash = await hashPassword(newPassword)
    full.mustChangePassword = false
  }
  Object.assign(full, { totpEnabled: true, totpLastStep: step, lastLoginAt: new Date(), tokenVersion: full.tokenVersion + 1 })
  await repo("PlatformAdmin").save(full)
  await audit({ ip }, "platform.mfa_enabled", { entityType: "platform_admin", entityId: full.id, details: { staff: full.name, staffId: full.id } })
  return full
}

// ---- Monitoring ------------------------------------------------------------------------

const n = (v) => Number(v || 0)
const INVALID_SCAN = "a.details->>'verdict' IS DISTINCT FROM 'valid'"

async function overview() {
  const [byStatus] = await AppDataSource.query(`
    SELECT
      count(*) FILTER (WHERE verification_status = 'pending') AS pending,
      count(*) FILTER (WHERE verification_status = 'verified') AS verified,
      count(*) FILTER (WHERE verification_status = 'unverified') AS unverified,
      count(*) FILTER (WHERE verification_status = 'rejected') AS rejected,
      count(*) FILTER (WHERE verification_status = 'suspended') AS suspended,
      count(*) AS total
    FROM organizations`)
  const [docs] = await AppDataSource.query(`
    SELECT count(*) FILTER (WHERE issued_at > now() - interval '30 days') AS issued30, count(*) FILTER (WHERE issued_at IS NOT NULL) AS issued
    FROM documents`)
  const [scans] = await AppDataSource.query(`
    SELECT count(*) AS scans30, count(*) FILTER (WHERE ${INVALID_SCAN}) AS invalid30
    FROM audit_events a WHERE a.action = 'document.verified' AND a.created_at > now() - interval '30 days'`)
  return {
    companies: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, n(v)])),
    documents: { issued: n(docs.issued), issued30: n(docs.issued30) },
    scans: { scans30: n(scans.scans30), invalid30: n(scans.invalid30) },
  }
}

const STATUSES = ["unverified", "pending", "verified", "rejected", "suspended"]

async function listCompanies({ status = "", q = "", sort = "" } = {}) {
  const params = []
  const where = []
  if (STATUSES.includes(status)) {
    params.push(status)
    where.push(`o.verification_status = $${params.length}`)
  }
  const term = String(q || "").trim().slice(0, 100)
  if (term) {
    params.push(`%${term.replace(/[\\%_]/g, "\\$&")}%`)
    const p = `$${params.length}`
    where.push(`(o.name ILIKE ${p} OR o.legal_name ILIKE ${p} OR o.slug ILIKE ${p} OR o.domain ILIKE ${p} OR o.registration_number ILIKE ${p})`)
  }
  const order = sort === "invalid"
    ? "invalid30 DESC, o.created_at DESC"
    : "(o.verification_status = 'pending') DESC, o.verification_requested_at ASC NULLS LAST, o.created_at DESC"
  const rows = await AppDataSource.query(`
    SELECT o.id, o.name, o.slug, o.legal_name, o.domain, o.verification_status, o.domain_verified_at,
           o.verification_requested_at, o.verified_at, o.created_at,
           (SELECT count(*) FROM users u WHERE u.organization_id = o.id) AS users,
           (SELECT count(*) FROM documents d WHERE d.organization_id = o.id AND d.issued_at IS NOT NULL) AS issued,
           (SELECT max(d.issued_at) FROM documents d WHERE d.organization_id = o.id) AS last_issued_at,
           (SELECT count(*) FROM audit_events a WHERE a.organization_id = o.id AND a.action = 'document.verified'
              AND a.created_at > now() - interval '30 days') AS scans30,
           (SELECT count(*) FROM audit_events a WHERE a.organization_id = o.id AND a.action = 'document.verified'
              AND a.created_at > now() - interval '30 days' AND ${INVALID_SCAN}) AS invalid30
    FROM organizations o
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${order}
    LIMIT 200`, params)
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    legalName: r.legal_name,
    domain: r.domain,
    status: r.verification_status,
    domainVerified: Boolean(r.domain_verified_at),
    requestedAt: r.verification_requested_at,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
    users: n(r.users),
    issued: n(r.issued),
    lastIssuedAt: r.last_issued_at,
    scans30: n(r.scans30),
    invalid30: n(r.invalid30),
  }))
}

async function companyDetail(ref) {
  const org = await findOrg(ref)
  const [users, docCounts, scanCounts, recentDocs, events, similar] = await Promise.all([
    repo("User").find({ where: { organizationId: org.id }, order: { createdAt: "ASC" } }),
    AppDataSource.query("SELECT status, count(*) AS c FROM documents WHERE organization_id = $1 GROUP BY status", [org.id]),
    AppDataSource.query(
      `SELECT coalesce(a.details->>'verdict', 'unknown') AS verdict, count(*) AS c FROM audit_events a
       WHERE a.organization_id = $1 AND a.action = 'document.verified' AND a.created_at > now() - interval '30 days' GROUP BY 1`,
      [org.id],
    ),
    repo("Document").find({
      where: { organizationId: org.id },
      order: { updatedAt: "DESC" },
      take: 15,
      select: ["id", "documentNo", "status", "publicId", "issuedAt", "updatedAt"],
    }),
    repo("AuditEvent").find({ where: { organizationId: org.id }, order: { createdAt: "DESC" }, take: 60 }),
    similarOrganizations(org),
  ])
  const templates = await repo("Template").count({ where: { organizationId: org.id } })
  const names = new Map(users.map((u) => [u.id, u.name]))
  const admins = users.filter((u) => u.role === "admin")
  const offDomain = org.domain
    ? admins.filter((u) => !u.email.endsWith(`@${org.domain}`) && !u.email.endsWith(`.${org.domain}`)).map((u) => u.email)
    : []

  return {
    organization: { ...publicOrg(org), createdAt: org.createdAt, verifiedBy: org.verifiedBy },
    users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.createdAt })),
    templates,
    documents: Object.fromEntries(docCounts.map((r) => [r.status, n(r.c)])),
    scans30: Object.fromEntries(scanCounts.map((r) => [r.verdict, n(r.c)])),
    recentDocuments: recentDocs,
    warnings: {
      adminsOffDomain: offDomain,
      similar: similar.map((o) => ({ id: o.id, name: o.legalName || o.name, slug: o.slug, domain: o.domain })),
    },
    events: events.map((e) => ({
      ...e,
      who: e.userId ? names.get(e.userId) || "Former user" : e.details && e.details.staff ? `${e.details.staff} (platform staff)` : "Public",
    })),
  }
}

// Staff-side log: platform sign-ins and every verification decision.
async function platformActivity({ limit = 200 } = {}) {
  const rows = await AppDataSource.query(
    `SELECT a.id, a.action, a.details, a.ip, a.created_at, a.organization_id, o.name AS org_name
     FROM audit_events a LEFT JOIN organizations o ON o.id = a.organization_id
     WHERE a.action LIKE 'platform.%' OR a.action LIKE 'organization.%'
     ORDER BY a.created_at DESC LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit) || 200))],
  )
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    createdAt: r.created_at,
    ip: r.ip,
    organizationId: r.organization_id,
    organizationName: r.org_name,
    who: r.details && r.details.staff ? r.details.staff : "Company",
    details: r.details || {},
  }))
}

module.exports = {
  createStaff,
  resetStaff,
  setStaffActive,
  login,
  startMfaSetup,
  finishMfaSetup,
  overview,
  listCompanies,
  companyDetail,
  platformActivity,
}

// People in a company: profile, invitations, roles and password resets.
const { In } = require("typeorm")
const { repo } = require("../config/database")
const { ROLES, hashPassword, publicUser } = require("../lib/auth")
const { randomPassword } = require("../lib/crypto")
const { audit } = require("../lib/audit")
const { cleanImage } = require("../lib/validate")
const { badRequest, notFound, conflict } = require("../lib/errors")
const { normalizeEmail, cleanName } = require("./org.service")

async function namesById(ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Map()
  const users = await repo("User").find({ where: { id: In(unique) }, select: ["id", "name"] })
  return new Map(users.map((u) => [u.id, u.name]))
}

// Who did something in the activity log: a person, platform staff, the system, or the public.
function actorName(event, names) {
  if (event.userId) return names.get(event.userId) || ""
  if (event.details && event.details.staff) return `${event.details.staff} (platform staff)`
  if (event.ip === "worker") return "System"
  return "Public"
}

async function updateProfile(ctx, { name, qualification, signature } = {}) {
  const user = ctx.user
  if (name !== undefined) user.name = cleanName(name, "Name")
  if (qualification !== undefined) user.qualification = String(qualification || "").slice(0, 500)
  if (signature !== undefined) user.signature = cleanImage(signature, "Signature")
  await repo("User").save(user)
  await audit(ctx, "user.profile_updated", { entityType: "user", entityId: user.id })
  return publicUser(user)
}

async function listUsers(orgId) {
  const users = await repo("User").find({ where: { organizationId: orgId }, order: { createdAt: "ASC" } })
  return users.map(publicUser)
}

// Returns the temporary password, shown once to the admin, who passes it on.
async function inviteUser(ctx, { email, name, role } = {}) {
  if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`)
  const mail = normalizeEmail(email)
  if (await repo("User").findOne({ where: { email: mail } })) throw conflict("An account with this email already exists")
  const temporaryPassword = randomPassword()
  const user = await repo("User").save({
    organizationId: ctx.user.organizationId,
    email: mail,
    name: cleanName(name, "Name"),
    role,
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
  })
  await audit(ctx, "user.created", { entityType: "user", entityId: user.id, details: { email: mail, role } })
  return { user: publicUser(user), temporaryPassword }
}

async function orgUser(ctx, id) {
  const user = await repo("User").findOne({ where: { id, organizationId: ctx.user.organizationId } })
  if (!user) throw notFound("User not found")
  return user
}

async function ensureAnotherAdmin(ctx, user) {
  const admins = await repo("User").count({ where: { organizationId: ctx.user.organizationId, role: "admin", active: true } })
  if (user.role === "admin" && user.active && admins <= 1) throw conflict("A company needs at least one active admin")
}

async function updateUser(ctx, id, { role, active, name } = {}) {
  const user = await orgUser(ctx, id)
  if ((role !== undefined && role !== "admin") || active === false) await ensureAnotherAdmin(ctx, user)
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw badRequest(`Role must be one of: ${ROLES.join(", ")}`)
    user.role = role
  }
  if (name !== undefined) user.name = cleanName(name, "Name")
  if (active !== undefined) {
    user.active = Boolean(active)
    if (!user.active) user.tokenVersion += 1
  }
  await repo("User").save(user)
  await audit(ctx, "user.updated", { entityType: "user", entityId: user.id, details: { role: user.role, active: user.active } })
  return publicUser(user)
}

async function resetUserPassword(ctx, id) {
  const user = await orgUser(ctx, id)
  const temporaryPassword = randomPassword()
  user.passwordHash = await hashPassword(temporaryPassword)
  user.mustChangePassword = true
  user.tokenVersion += 1
  await repo("User").save(user)
  await audit(ctx, "user.password_reset", { entityType: "user", entityId: user.id })
  return { temporaryPassword }
}

module.exports = { namesById, actorName, updateProfile, listUsers, inviteUser, updateUser, resetUserPassword }

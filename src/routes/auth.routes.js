const express = require("express")
const rateLimit = require("express-rate-limit")
const { repo } = require("../config/database")
const {
  hashPassword, checkPassword, validatePassword, setSession, clearSession, requireAuth, publicUser,
} = require("../lib/auth")
const { createOrganizationWithAdmin, normalizeEmail, publicOrg } = require("../services/org.service")
const { audit } = require("../lib/audit")
const { HttpError } = require("../lib/errors")

const router = express.Router()

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts. Try again in a few minutes." },
})

router.post("/signup", authLimiter, async (req, res) => {
  if (String(process.env.ALLOW_SIGNUP || "true").toLowerCase() === "false") {
    throw new HttpError(403, "Sign-up is closed. Ask your administrator for an account.")
  }
  const { organization, user } = await createOrganizationWithAdmin(req.body || {})
  req.user = user
  await audit(req, "organization.created", { entityType: "organization", entityId: organization.id })
  setSession(res, user)
  res.status(201).json({ user: publicUser(user), organization: publicOrg(organization) })
})

router.post("/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {}
  let mail
  try {
    mail = normalizeEmail(email)
  } catch {
    throw new HttpError(401, "Email or password is incorrect")
  }
  const user = await repo("User")
    .createQueryBuilder("u")
    .addSelect("u.passwordHash")
    .where("u.email = :email", { email: mail })
    .getOne()
  const ok = user && user.active && (await checkPassword(String(password || ""), user.passwordHash))
  if (!ok) {
    if (user) await audit({ user, ip: req.ip }, "auth.login_failed", { entityType: "user", entityId: user.id })
    throw new HttpError(401, "Email or password is incorrect")
  }
  req.user = user
  await audit(req, "auth.login", { entityType: "user", entityId: user.id })
  setSession(res, user)
  res.json({ user: publicUser(user) })
})

router.post("/logout", (req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

router.get("/me", async (req, res) => {
  if (!req.user) throw new HttpError(401, "Please sign in")
  const org = await repo("Organization").findOne({ where: { id: req.user.organizationId } })
  res.json({ user: publicUser(req.user), organization: publicOrg(org) })
})

router.post(
  "/password",
  (req, res, next) => {
    req.allowTempPassword = true
    next()
  },
  requireAuth,
  async (req, res) => {
    const { currentPassword, newPassword } = req.body || {}
    const user = await repo("User")
      .createQueryBuilder("u")
      .addSelect("u.passwordHash")
      .where("u.id = :id", { id: req.user.id })
      .getOne()
    if (!(await checkPassword(String(currentPassword || ""), user.passwordHash))) {
      throw new HttpError(400, "Current password is incorrect")
    }
    validatePassword(newPassword)
    user.passwordHash = await hashPassword(newPassword)
    user.mustChangePassword = false
    user.tokenVersion += 1 // signs out other sessions
    await repo("User").save(user)
    await audit(req, "auth.password_changed", { entityType: "user", entityId: user.id })
    setSession(res, user)
    res.json({ ok: true })
  },
)

module.exports = router

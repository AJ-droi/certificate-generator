// API for the platform staff dashboard (/platform).
const express = require("express")
const QRCode = require("qrcode")
const platform = require("../services/platform.service")
const orgs = require("../services/org.service")
const { setStaffSession, clearStaffSession, loadStaff, requireStaff, publicStaff } = require("../lib/platform-auth")
const { HttpError, badRequest } = require("../lib/errors")
const { limiter } = require("../lib/rate-limit")
const { config } = require("../config")

const router = express.Router()
router.use(loadStaff)

const loginLimiter = limiter({
  name: "platform-auth",
  windowMs: 15 * 60 * 1000,
  limit: () => config.rateLimits.platformAuth,
  message: "Too many attempts. Try again in a few minutes.",
})

// ---- Sign-in and authenticator setup ------------------------------------------------

router.post("/auth/login", loginLimiter, async (req, res) => {
  const { staff, mfa } = await platform.login(req.body || {}, req.ip)
  setStaffSession(res, staff, { mfa })
  res.json({ staff: publicStaff(staff), setupRequired: !mfa })
})

router.post("/auth/logout", (req, res) => {
  clearStaffSession(res)
  res.json({ ok: true })
})

router.get("/auth/me", (req, res) => {
  if (!req.staff) throw new HttpError(401, "Please sign in")
  res.json({ staff: publicStaff(req.staff), setupRequired: !req.staffMfa })
})

function requireSetupSession(req, res, next) {
  if (!req.staff) throw new HttpError(401, "Please sign in")
  next()
}

router.post("/auth/setup/start", loginLimiter, requireSetupSession, async (req, res) => {
  const { secret, otpauthUrl } = await platform.startMfaSetup(req.staff)
  const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 })
  res.json({ secret, qr, mustChangePassword: req.staff.mustChangePassword })
})

router.post("/auth/setup/finish", loginLimiter, requireSetupSession, async (req, res) => {
  const staff = await platform.finishMfaSetup(req.staff, req.body || {}, req.ip)
  setStaffSession(res, staff, { mfa: true })
  res.json({ staff: publicStaff(staff) })
})

// ---- Everything below needs a full (password + code) session ------------------------------

router.use(requireStaff)

const by = (req) => ({ id: req.staff.id, name: req.staff.name })

router.get("/overview", async (req, res) => {
  const [stats, pending, flagged] = await Promise.all([
    platform.overview(),
    platform.listCompanies({ status: "pending" }),
    platform.listCompanies({ sort: "invalid" }),
  ])
  res.json({ stats, pending, flagged: flagged.filter((c) => c.invalid30 > 0).slice(0, 10) })
})

router.get("/companies", async (req, res) => {
  res.json({ companies: await platform.listCompanies({ status: req.query.status, q: req.query.q, sort: req.query.sort }) })
})

router.get("/companies/:id", async (req, res) => {
  res.json(await platform.companyDetail(req.params.id))
})

router.post("/companies/:id/check-dns", async (req, res) => {
  const { found } = await orgs.staffCheckDomain(req.params.id, by(req))
  res.json({ found })
})

router.post("/companies/:id/verify", async (req, res) => {
  const b = req.body || {}
  if (b.registryChecked !== true) throw badRequest("Confirm you checked the registration with the official registry")
  await orgs.verifyOrganization(req.params.id, {
    by: by(req),
    registryChecked: true,
    trustDomain: b.trustDomain === true,
    legalName: b.legalName,
    registrationNumber: b.registrationNumber,
    registrationCountry: b.registrationCountry,
    domain: b.domain,
  })
  res.json(await platform.companyDetail(req.params.id))
})

router.post("/companies/:id/reject", async (req, res) => {
  await orgs.rejectOrganization(req.params.id, { by: by(req), reason: (req.body || {}).reason })
  res.json(await platform.companyDetail(req.params.id))
})

router.post("/companies/:id/suspend", async (req, res) => {
  await orgs.suspendOrganization(req.params.id, { by: by(req), reason: (req.body || {}).reason })
  res.json(await platform.companyDetail(req.params.id))
})

router.get("/activity", async (req, res) => {
  res.json({ events: await platform.platformActivity({ limit: req.query.limit }) })
})

module.exports = router

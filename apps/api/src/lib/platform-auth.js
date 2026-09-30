// Sessions for platform staff (/platform). Separate cookie, separate signing key
// and a separate table from company users, so a company session can never be used
// here and vice versa. Staff must use an authenticator app: until they've set one
// up, their session can only do that.
const jwt = require("jsonwebtoken")
const { deriveKey } = require("./crypto")
const { repo } = require("../config/database")
const { HttpError } = require("./errors")
const { config } = require("../config")

const COOKIE = "psid"
const SESSION_HOURS = 8
const jwtKey = () => deriveKey("platform-session-jwt")

function setStaffSession(res, staff, { mfa }) {
  const token = jwt.sign({ pid: staff.id, tv: staff.tokenVersion, mfa: Boolean(mfa) }, jwtKey(), {
    expiresIn: mfa ? `${SESSION_HOURS}h` : "15m",
  })
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.isProduction,
    maxAge: (mfa ? SESSION_HOURS * 3600 : 15 * 60) * 1000,
    path: "/",
  })
}

const clearStaffSession = (res) => res.clearCookie(COOKIE, { path: "/" })

// Sets req.staff (and req.staffMfa) from a valid session. Never rejects.
async function loadStaff(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE]
  if (!token) return next()
  try {
    const claims = jwt.verify(token, jwtKey())
    const staff = await repo("PlatformAdmin").findOne({ where: { id: claims.pid } })
    if (staff && staff.active && staff.tokenVersion === claims.tv) {
      req.staff = staff
      req.staffMfa = claims.mfa === true && staff.totpEnabled
    }
  } catch {
    clearStaffSession(res)
  }
  next()
}

function requireStaff(req, res, next) {
  if (!req.staff) throw new HttpError(401, "Please sign in")
  if (!req.staffMfa) throw new HttpError(403, "Set up your authenticator app first", { code: "setup_required" })
  next()
}

// Optional: only let these IP addresses reach /platform at all (comma-separated).
function staffIpAllowlist(req, res, next) {
  const list = config.platformAllowedIps
  if (list.length && !list.includes(req.ip)) return res.status(404).send("Not found")
  next()
}

const publicStaff = (s) =>
  s && { id: s.id, email: s.email, name: s.name, totpEnabled: s.totpEnabled, mustChangePassword: s.mustChangePassword, lastLoginAt: s.lastLoginAt }

module.exports = { setStaffSession, clearStaffSession, loadStaff, requireStaff, staffIpAllowlist, publicStaff }

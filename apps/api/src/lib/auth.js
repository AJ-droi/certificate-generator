const jwt = require("jsonwebtoken")
const bcrypt = require("bcryptjs")
const { deriveKey } = require("./crypto")
const { repo } = require("../config/database")
const { HttpError, forbidden } = require("./errors")
const { config } = require("../config")

const COOKIE = "sid"
const SESSION_HOURS = 12
const ROLES = ["admin", "approver", "issuer"]

const jwtKey = () => deriveKey("session-jwt")

const hashPassword = (password) => bcrypt.hash(password, 12)
const checkPassword = (password, hash) => bcrypt.compare(password, hash || "")

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 10) {
    throw new HttpError(400, "Password must be at least 10 characters")
  }
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, tv: user.tokenVersion }, jwtKey(), {
    expiresIn: `${SESSION_HOURS}h`,
  })
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: SESSION_HOURS * 3600 * 1000,
    path: "/",
  })
}

function clearSession(res) {
  res.clearCookie(COOKIE, { path: "/" })
}

// Loads req.user if a valid session cookie is present. Never rejects.
async function loadUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE]
  if (!token) return next()
  try {
    const claims = jwt.verify(token, jwtKey())
    const user = await repo("User").findOne({ where: { id: claims.uid } })
    if (user && user.active && user.tokenVersion === claims.tv) req.user = user
  } catch {
    clearSession(res)
  }
  next()
}

function requireAuth(req, res, next) {
  if (!req.user) throw new HttpError(401, "Please sign in")
  // Users with a temporary password may only change it.
  if (req.user.mustChangePassword && !req.allowTempPassword) {
    throw new HttpError(403, "You need to set a new password first", { code: "must_change_password" })
  }
  next()
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) throw forbidden()
  next()
}

// Blocks cross-site form posts: browsers can't send JSON (or a PDF body)
// cross-origin without a CORS preflight, which this server never approves.
function requireJsonForWrites(req, res, next) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json") && !req.is("application/pdf")) {
    throw new HttpError(415, "Send requests as JSON")
  }
  next()
}

const publicUser = (u) =>
  u && {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    qualification: u.qualification,
    signature: u.signature || null,
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
  }

module.exports = {
  ROLES,
  hashPassword,
  checkPassword,
  validatePassword,
  setSession,
  clearSession,
  loadUser,
  requireAuth,
  requireRole,
  requireJsonForWrites,
  publicUser,
}

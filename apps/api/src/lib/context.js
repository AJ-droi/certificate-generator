// What services need to know about who is acting: the user (if any), their IP
// for the activity log, and the address printed in QR codes. Services take this
// instead of Express's `req`, so scripts and background jobs can call them too.
const { config } = require("../config")

const baseUrlFor = (req) => config.publicBaseUrl || `${req.protocol}://${req.get("host")}`

const requestContext = (req) => ({ user: req.user || null, ip: req.ip, baseUrl: baseUrlFor(req) })

// For scripts and jobs. `baseUrl` falls back to PUBLIC_BASE_URL.
const systemContext = ({ user = null, ip = "system", baseUrl } = {}) => ({
  user,
  ip,
  baseUrl: (baseUrl || config.publicBaseUrl || `http://localhost:${config.port}`).replace(/\/+$/, ""),
})

module.exports = { requestContext, systemContext, baseUrlFor }

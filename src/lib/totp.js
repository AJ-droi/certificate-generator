// Time-based one-time codes (RFC 6238, as used by Google Authenticator, 1Password,
// Authy…): 6 digits, 30-second steps, HMAC-SHA1.
const crypto = require("crypto")

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const STEP_SECONDS = 30

function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(str) {
  let bits = 0
  let value = 0
  const out = []
  for (const ch of String(str).toUpperCase().replace(/[\s=]/g, "")) {
    const i = B32.indexOf(ch)
    if (i === -1) throw new Error("Invalid base32")
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const newSecret = () => base32Encode(crypto.randomBytes(20))
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS)

function codeAt(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(n).padStart(6, "0")
}

// Returns the step the code belongs to (store it, so the same code can't be used
// twice), or null. Accepts one step either side for clock drift.
function verifyCode(secret, code, lastUsedStep = 0, now = Date.now()) {
  const given = String(code || "").replace(/\s/g, "")
  if (!/^\d{6}$/.test(given)) return null
  const step = currentStep(now)
  for (const s of [step - 1, step, step + 1]) {
    if (s <= lastUsedStep) continue
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(given))) return s
  }
  return null
}

const otpauthUrl = ({ secret, account, issuer }) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: String(STEP_SECONDS) })}`

module.exports = { newSecret, codeAt, currentStep, verifyCode, otpauthUrl }

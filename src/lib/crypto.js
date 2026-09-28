const crypto = require("crypto")

function appSecret() {
  const secret = process.env.APP_SECRET
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("APP_SECRET must be set (32+ characters) in production")
    }
    return "dev-only-insecure-secret-change-me-please-0000"
  }
  return secret
}

function deriveKey(purpose) {
  return Buffer.from(crypto.hkdfSync("sha256", appSecret(), "certificate-generator", purpose, 32))
}

// Deterministic JSON: object keys sorted, so the same data always hashes the same.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`
}

const sha256 = (input) => crypto.createHash("sha256").update(input).digest("hex")

function encrypt(plain) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey("private-keys"), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".")
}

function decrypt(payload) {
  const [version, iv, tag, enc] = String(payload).split(".")
  if (version !== "v1") throw new Error("Unknown key encryption format")
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey("private-keys"), Buffer.from(iv, "base64"))
  decipher.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8")
}

function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
  const publicPem = publicKey.export({ type: "spki", format: "pem" })
  return {
    keyId: sha256(publicPem).slice(0, 16),
    publicKey: publicPem,
    privateKeyEnc: encrypt(privateKey.export({ type: "pkcs8", format: "pem" })),
  }
}

function signPayload(payload, privateKeyEnc) {
  const key = crypto.createPrivateKey(decrypt(privateKeyEnc))
  const bytes = Buffer.from(canonicalJson(payload), "utf8")
  return { contentHash: sha256(bytes), signature: crypto.sign(null, bytes, key).toString("base64") }
}

function verifyPayload(payload, signature, publicKeyPem) {
  try {
    const bytes = Buffer.from(canonicalJson(payload), "utf8")
    return crypto.verify(null, bytes, crypto.createPublicKey(publicKeyPem), Buffer.from(signature, "base64"))
  } catch {
    return false
  }
}

// 120 random bits, Crockford base32 (no I, L, O, U): easy to read out or type.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function newPublicId() {
  const bytes = crypto.randomBytes(15)
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

function normalizePublicId(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0")
    .slice(0, 40)
}

const formatPublicId = (id) => String(id).match(/.{1,4}/g).join("-")

function randomPassword() {
  return crypto.randomBytes(9).toString("base64url")
}

module.exports = {
  appSecret,
  deriveKey,
  canonicalJson,
  sha256,
  generateSigningKey,
  signPayload,
  verifyPayload,
  newPublicId,
  normalizePublicId,
  formatPublicId,
  randomPassword,
}

const { test } = require("node:test")
const assert = require("node:assert/strict")
const totp = require("../../src/lib/totp")

// RFC 6238 test secret "12345678901234567890" in base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

test("matches the RFC 6238 test vector", () => {
  // T = 59s -> step 1 -> 94287082 (8 digits); the last 6 digits are 287082.
  assert.equal(totp.codeAt(RFC_SECRET, 1), "287082")
})

test("accepts the current code and one step either side, but not further", () => {
  const s = totp.newSecret()
  const now = 1_700_000_000_000
  const step = totp.currentStep(now)
  assert.equal(totp.verifyCode(s, totp.codeAt(s, step), 0, now), step)
  assert.equal(totp.verifyCode(s, totp.codeAt(s, step - 1), 0, now), step - 1)
  assert.equal(totp.verifyCode(s, totp.codeAt(s, step + 1), 0, now), step + 1)
  assert.equal(totp.verifyCode(s, totp.codeAt(s, step + 3), 0, now), null)
})

test("a used code (or an older one) can't be replayed", () => {
  const s = totp.newSecret()
  const now = 1_700_000_000_000
  const step = totp.currentStep(now)
  assert.equal(totp.verifyCode(s, totp.codeAt(s, step), step, now), null)
  assert.equal(totp.verifyCode(s, totp.codeAt(s, step - 1), step, now), null)
})

test("rejects malformed codes and allows spaces", () => {
  const s = totp.newSecret()
  const now = 1_700_000_000_000
  const code = totp.codeAt(s, totp.currentStep(now))
  assert.equal(totp.verifyCode(s, "12345", 0, now), null)
  assert.equal(totp.verifyCode(s, "abcdef", 0, now), null)
  assert.equal(totp.verifyCode(s, `${code.slice(0, 3)} ${code.slice(3)}`, 0, now), totp.currentStep(now))
})

test("otpauth URL carries the secret and issuer", () => {
  const url = totp.otpauthUrl({ secret: "ABC", account: "a@b.test", issuer: "DocTrust staff" })
  assert.match(url, /^otpauth:\/\/totp\/DocTrust%20staff%3Aa%40b\.test\?/)
  assert.match(url, /secret=ABC/)
})

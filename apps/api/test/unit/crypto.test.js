const { test } = require("node:test")
const assert = require("node:assert/strict")
process.env.APP_SECRET = process.env.APP_SECRET && process.env.APP_SECRET.length >= 32 ? process.env.APP_SECRET : "unit-test-secret-0123456789-abcdefghijklmnop"
const c = require("../../src/lib/crypto")

test("canonical JSON ignores key order and undefined values", () => {
  assert.equal(c.canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  assert.equal(c.canonicalJson({ a: 1, b: 2 }), c.canonicalJson({ b: 2, a: 1 }))
})

test("a signature verifies, and fails if anything changes", () => {
  const key = c.generateSigningKey()
  const payload = { documentNo: "A-1", data: { name: "Ada" } }
  const { signature, contentHash } = c.signPayload(payload, key.privateKeyEnc)
  assert.match(contentHash, /^[a-f0-9]{64}$/)
  assert.equal(c.verifyPayload(payload, signature, key.publicKey), true)
  assert.equal(c.verifyPayload({ ...payload, documentNo: "A-2" }, signature, key.publicKey), false)
  assert.equal(c.verifyPayload(payload, signature, c.generateSigningKey().publicKey), false)
  assert.equal(c.verifyPayload(payload, "not-base64!!", key.publicKey), false)
})

test("private keys are stored encrypted", () => {
  const key = c.generateSigningKey()
  assert.doesNotMatch(key.privateKeyEnc, /PRIVATE KEY/)
  assert.match(key.privateKeyEnc, /^v1\./)
})

test("verification codes: 24 characters, readable alphabet, forgiving input", () => {
  const id = c.newPublicId()
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{24}$/)
  assert.notEqual(id, c.newPublicId())
  assert.equal(c.normalizePublicId(c.formatPublicId(id).toLowerCase()), id)
  assert.equal(c.normalizePublicId("oIl-O"), "0110")
})

test("the app refuses to run without a real secret", () => {
  const saved = process.env.APP_SECRET
  process.env.APP_SECRET = "short"
  try {
    assert.throws(() => c.appSecret(), /APP_SECRET/)
  } finally {
    process.env.APP_SECRET = saved
  }
})

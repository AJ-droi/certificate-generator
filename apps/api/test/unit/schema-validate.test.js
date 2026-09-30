const { test } = require("node:test")
const assert = require("node:assert/strict")
const { validateSchema, normalizeData, verifyFields } = require("../../src/lib/schema")
const { likePattern, cleanImage, isUuid } = require("../../src/lib/validate")

test("field schemas: bad keys, reserved names, duplicates and empty tables are rejected", () => {
  assert.throws(() => validateSchema([{ key: "1bad" }]), /must start with a letter/)
  assert.throws(() => validateSchema([{ key: "qr" }]), /reserved/)
  assert.throws(() => validateSchema([{ key: "a" }, { key: "a" }]), /duplicate/)
  assert.throws(() => validateSchema([{ key: "t", type: "table", columns: [] }]), /needs columns/)
  assert.throws(() => validateSchema({}), /array/)
  const ok = validateSchema([{ key: "name", label: "Name", required: true }])
  assert.deepEqual(ok, [{ key: "name", label: "Name", type: "text", required: true }])
})

test("document data is cleaned, and required fields are enforced when strict", () => {
  const schema = validateSchema([
    { key: "name", label: "Name", required: true },
    { key: "count", label: "Count", type: "number" },
    { key: "ok", label: "OK", type: "checkbox" },
  ])
  const data = normalizeData(schema, { name: "Ada", count: "3", ok: "yes", extra: "dropped" })
  assert.equal(data.name, "Ada")
  assert.equal(data.extra, undefined)
  assert.throws(() => normalizeData(schema, { name: "" }, { strict: true }), (err) => err.status === 400)
})

test("verify page shows flagged fields", () => {
  const schema = validateSchema([{ key: "a", label: "A" }, { key: "b", label: "B", showOnVerify: true }])
  assert.deepEqual(verifyFields(schema, { a: "x", b: "y" }), [{ label: "B", value: "y" }])
})

test("search text can't act as a wildcard", () => {
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%")
})

test("images must be small PNG/JPEG/WebP/GIF data URLs", () => {
  assert.equal(cleanImage(null, "Logo"), null)
  assert.equal(cleanImage("data:image/png;base64,AAAA", "Logo"), "data:image/png;base64,AAAA")
  assert.throws(() => cleanImage("data:image/svg+xml;base64,AAAA", "Logo"), /PNG/)
  assert.throws(() => cleanImage(`data:image/png;base64,${"A".repeat(800_000)}`, "Logo"), /too large/)
  assert.equal(isUuid("00000000-0000-4000-8000-000000000000"), true)
  assert.equal(isUuid("nope"), false)
})

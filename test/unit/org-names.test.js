const { test } = require("node:test")
const assert = require("node:assert/strict")
const { normalizeDomain, nameKey } = require("../../src/services/org.service")

test("domains are normalised from whatever people type", () => {
  assert.equal(normalizeDomain("Shell.com"), "shell.com")
  assert.equal(normalizeDomain("https://www.shell.com/ng/about?x=1"), "shell.com")
  assert.equal(normalizeDomain("sub.example.co.uk"), "sub.example.co.uk")
  assert.equal(normalizeDomain("bücher.de"), "xn--bcher-kva.de")
})

test("things that aren't public domains are rejected", () => {
  for (const bad of ["", "localhost", "1.2.3.4", "a..com", "not a domain", "http://"]) {
    assert.throws(() => normalizeDomain(bad), /domain/i, bad)
  }
})

test("look-alike company names match", () => {
  const acme = nameKey("Acme Inspections")
  for (const lookAlike of ["ACME Inspections Ltd.", "Acme Inspections Limited", "Acme lnspections", "Acme Inspect1ons Nig. Ltd"]) {
    assert.equal(nameKey(lookAlike), acme, lookAlike)
  }
  assert.notEqual(nameKey("Beta Testing"), acme)
})

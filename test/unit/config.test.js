const { test } = require("node:test")
const assert = require("node:assert/strict")
const { config, assertConfig } = require("../../src/config")

const GOOD = "q7Zp0cV3xT9wL2mN8bR4yK6hJ1fD5sA0gE3uI7oP9lQ2="

function withEnv(vars, fn) {
  const saved = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test("a missing or short APP_SECRET stops start-up", () => {
  withEnv({ APP_SECRET: undefined, NODE_ENV: "development" }, () => assert.throws(assertConfig, /APP_SECRET must be at least 32/))
  withEnv({ APP_SECRET: "too-short", NODE_ENV: "development" }, () => assert.throws(assertConfig, /APP_SECRET/))
  withEnv({ APP_SECRET: GOOD, NODE_ENV: "development", STORAGE_DRIVER: undefined, REDIS_URL: undefined }, () => assertConfig())
})

test("production needs a random secret and an https PUBLIC_BASE_URL", () => {
  withEnv({ NODE_ENV: "production", APP_SECRET: "change-me-change-me-change-me-change-me", PUBLIC_BASE_URL: "https://verify.example.com" }, () =>
    assert.throws(assertConfig, /placeholder/))
  withEnv({ NODE_ENV: "production", APP_SECRET: GOOD, PUBLIC_BASE_URL: "http://verify.example.com" }, () => assert.throws(assertConfig, /PUBLIC_BASE_URL/))
  withEnv({ NODE_ENV: "production", APP_SECRET: GOOD, PUBLIC_BASE_URL: "https://verify.example.com/", STORAGE_DRIVER: undefined, REDIS_URL: undefined }, () => {
    assertConfig()
    assert.equal(config.publicBaseUrl, "https://verify.example.com")
  })
})

test("storage and Redis settings are checked", () => {
  withEnv({ APP_SECRET: GOOD, NODE_ENV: "development", STORAGE_DRIVER: "ftp" }, () => assert.throws(assertConfig, /STORAGE_DRIVER/))
  withEnv({ APP_SECRET: GOOD, NODE_ENV: "development", STORAGE_DRIVER: "s3", S3_BUCKET: undefined }, () => assert.throws(assertConfig, /S3_BUCKET/))
  withEnv({ APP_SECRET: GOOD, NODE_ENV: "development", STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "x", S3_SECRET_ACCESS_KEY: undefined }, () =>
    assert.throws(assertConfig, /both S3_ACCESS_KEY_ID/))
  withEnv({ APP_SECRET: GOOD, NODE_ENV: "development", STORAGE_DRIVER: undefined, REDIS_URL: "localhost:6379" }, () => assert.throws(assertConfig, /REDIS_URL/))
})

test("all problems are reported together", () => {
  withEnv({ APP_SECRET: undefined, NODE_ENV: "production", PUBLIC_BASE_URL: undefined, STORAGE_DRIVER: "s3", S3_BUCKET: undefined }, () => {
    try {
      assertConfig()
      assert.fail("should throw")
    } catch (err) {
      assert.equal(err.code, "CONFIG_INVALID")
      for (const k of ["APP_SECRET", "PUBLIC_BASE_URL", "S3_BUCKET"]) assert.match(err.message, new RegExp(k))
    }
  })
})

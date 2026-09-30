// Starts the app (with a background worker, so PDFs get made) against a fresh
// database, and creates the accounts the browser tests use.
const PORT = Number(process.env.UI_TEST_PORT || 3199)

module.exports = async () => {
  process.env.TEST_DATABASE_URL = process.env.UI_TEST_DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5433/certificate_generator_ui_test"
  const h = require("../apps/api/test/helpers")
  const { Worker } = require("../apps/api/src/services/jobs.service")
  const platform = require("../apps/api/src/services/platform.service")
  const totp = require("../apps/api/src/lib/totp")

  await h.startApp({ port: PORT })
  const worker = new Worker({ pollMs: 200 })
  worker.start()

  // Verified company with an admin, an approver and an issuer (see support.js).
  await h.createCompany({ name: "Acme Inspections", domain: "acme.test" })
  // A company waiting for review, for the staff dashboard test.
  const beta = await h.createCompany({ name: "Beta Testing", domain: "beta.test", verified: false })
  const req = await beta.admin("POST", "/api/org/verification", { legalName: "Beta Testing Limited", registrationNumber: "RC 777", registrationCountry: "NG", domain: "beta.test" })
  if (req.status !== 200) throw new Error(`Couldn't request verification: ${JSON.stringify(req.data)}`)

  // A staff member who has already set up their authenticator app.
  const { temporaryPassword } = await platform.createStaff({ email: "sam@platform.test", name: "Sam Staff" })
  const staff = h.client()
  await staff("POST", "/api/platform/auth/login", { email: "sam@platform.test", password: temporaryPassword })
  const setup = await staff("POST", "/api/platform/auth/setup/start", {})
  const done = await staff("POST", "/api/platform/auth/setup/finish", { code: totp.codeAt(setup.data.secret, totp.currentStep()), newPassword: "staff-password-123" })
  if (done.status !== 200) throw new Error(`Staff setup failed: ${JSON.stringify(done.data)}`)
  process.env.UI_STAFF_TOTP_SECRET = setup.data.secret

  return async () => {
    await worker.stop()
    await h.stopApp()
  }
}

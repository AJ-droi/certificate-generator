// Browser tests of both dashboards (npm run test:ui). They start the app
// themselves against certificate_generator_ui_test (wiped on every run).
const { defineConfig, devices } = require("@playwright/test")

const PORT = Number(process.env.UI_TEST_PORT || 3199)

module.exports = defineConfig({
  testDir: "e2e-ui",
  globalSetup: "./e2e-ui/global-setup.js",
  // One shared database and server: run the files one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${PORT}`,
    // Locally: PW_CHANNEL=chrome uses your installed Google Chrome instead of a download.
    channel: process.env.PW_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})

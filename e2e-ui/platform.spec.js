// The staff dashboard: sign in with an authenticator code, review a company, verify it.
const { test, expect } = require("@playwright/test")
const { platformUrl, dialog } = require("./support")
const totp = require("../apps/api/src/lib/totp")

test("staff sign in with a code, review the queue and verify a company", async ({ page }) => {
  await page.goto(platformUrl("/login"))
  await expect(page.getByRole("heading", { name: "Platform staff" })).toBeVisible()
  await page.getByLabel("Email").fill("sam@platform.test")
  await page.getByLabel("Password").fill("staff-password-123")
  // The set-up used the current code; the next one is still accepted.
  await page.getByLabel("Authenticator code").fill(totp.codeAt(process.env.UI_STAFF_TOTP_SECRET, totp.currentStep() + 1))
  await page.getByRole("button", { name: "Sign in" }).click()

  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
  const row = page.getByRole("row", { name: /Beta Testing/ })
  await expect(row).toBeVisible()
  await row.click()

  await expect(page.getByRole("heading", { name: "Beta Testing Limited" })).toBeVisible()
  await expect(page.getByText("Waiting for review")).toBeVisible()
  await expect(page.getByText("beta.test hasn't been proven with its DNS record.")).toBeVisible()
  await page.getByRole("button", { name: "Verify company" }).click()
  await dialog(page).getByRole("button", { name: "Verify" }).click()
  await expect(dialog(page).getByRole("alert")).toContainText("Tick the box")
  await dialog(page).getByLabel(/I checked the name and registration number/).check()
  await dialog(page).getByLabel(/I confirmed they control it another way/).check()
  await dialog(page).getByRole("button", { name: "Verify" }).click()
  await expect(page.locator(".badge", { hasText: "Verified" })).toBeVisible()

  await page.getByRole("link", { name: "Activity log" }).click()
  await expect(page.getByRole("cell", { name: "organization.verified" }).first()).toBeVisible()
})

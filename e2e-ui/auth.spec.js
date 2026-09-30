// Signing in and out, signing up a company, requesting verification, and
// inviting someone who must then choose their own password.
const { test, expect } = require("@playwright/test")
const { USERS, appUrl, signIn, nav, dialog } = require("./support")

test("wrong password shows an error; the right one opens the dashboard; sign out", async ({ page }) => {
  await page.goto(appUrl("/login"))
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await page.getByLabel("Email").fill(USERS.admin.email)
  await page.getByLabel("Password", { exact: true }).fill("not-the-password")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("alert")).toContainText("Email or password is incorrect")

  await page.getByLabel("Password", { exact: true }).fill(USERS.admin.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible()
  await expect(page.getByText("Acme Inspections", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
})

test("a new company signs up, is told it isn't verified, and requests verification", async ({ page }) => {
  await page.goto(appUrl("/signup"))
  await page.getByLabel("Company name").fill("Gamma Labs")
  await page.getByLabel("Your name").fill("Gina Gamma")
  await page.getByLabel("Work email").fill("gina@gamma.test")
  // The label includes its hint ("At least 10 characters").
  await page.getByLabel(/^Password/).fill("gamma-password-1")
  await page.getByRole("button", { name: "Create account" }).click()

  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible()
  await expect(page.getByRole("status").filter({ hasText: "isn't verified yet" })).toBeVisible()
  await page.getByRole("link", { name: "Go to verification" }).click()

  await expect(page.getByRole("heading", { name: "Company verification" })).toBeVisible()
  await page.getByLabel("Registered company name").fill("Gamma Labs Limited")
  await page.getByLabel("Registration number").fill("RC 555")
  await page.getByLabel("Country of registration").selectOption({ label: "Nigeria" })
  await page.getByLabel("Website domain").fill("gamma.test")
  await page.getByRole("button", { name: "Request verification" }).click()

  await expect(page.getByText("Under review")).toBeVisible()
  await expect(page.getByText("_docverify.gamma.test")).toBeVisible()
  await expect(page.getByRole("button", { name: "Check DNS record" })).toBeVisible()
})

test("an admin invites a person, who must choose their own password", async ({ page, browser }) => {
  await signIn(page, "admin")
  await nav(page, "People")
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible()
  await page.getByRole("button", { name: "Add person" }).click()
  await dialog(page).getByLabel("Name").fill("Nora New")
  await dialog(page).getByLabel("Email").fill("nora@acme.test")
  await dialog(page).getByRole("button", { name: "Add" }).click()
  await expect(dialog(page).getByRole("heading", { name: "Share this temporary password" })).toBeVisible()
  const temporary = (await dialog(page).locator(".secret").textContent()).trim()
  await dialog(page).getByRole("button", { name: "Done" }).click()
  await expect(page.getByRole("cell", { name: /Nora New/ })).toBeVisible()

  const context = await browser.newContext()
  const nora = await context.newPage()
  await nora.goto(appUrl("/login"))
  await nora.getByLabel("Email").fill("nora@acme.test")
  await nora.getByLabel("Password", { exact: true }).fill(temporary)
  await nora.getByRole("button", { name: "Sign in" }).click()
  await expect(nora.getByRole("heading", { name: "Set a new password" })).toBeVisible()
  await nora.getByLabel("Current (temporary) password").fill(temporary)
  await nora.getByLabel("New password").fill("nora-password-123")
  await nora.getByRole("button", { name: "Save password" }).click()
  await expect(nora.getByRole("heading", { name: "Documents", exact: true })).toBeVisible()
  await context.close()
})

test("admins see the activity log; issuers don't", async ({ page, browser }) => {
  await signIn(page, "admin")
  await nav(page, "Activity log")
  await expect(page.getByRole("heading", { name: "Activity log" })).toBeVisible()
  await expect(page.getByRole("cell", { name: "user.created" }).first()).toBeVisible()

  const context = await browser.newContext()
  const issuer = await context.newPage()
  await signIn(issuer, "issuer")
  await expect(issuer.getByRole("navigation").getByRole("link", { name: "Activity log" })).toHaveCount(0)
  await context.close()
})

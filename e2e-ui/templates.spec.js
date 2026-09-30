// The HTML template editor, and links saved from before the React version.
const { test, expect } = require("@playwright/test")
const { signIn, nav } = require("./support")

test("an admin creates an HTML template from the example, adds a field and previews it", async ({ page }) => {
  await signIn(page, "admin")
  await nav(page, "Templates")
  await page.getByRole("link", { name: "Add template" }).click()
  await page.getByRole("link", { name: /Design with HTML/ }).click()
  await expect(page.getByRole("heading", { name: "Add template" })).toBeVisible()
  // The preview of the starter layout loads in a sandboxed frame.
  await expect(page.frameLocator('iframe[title="Template preview"]').getByText("Certificate of Completion")).toBeVisible()

  await page.getByRole("tab", { name: "Fields" }).click()
  await page.getByRole("button", { name: "+ Add field" }).click()
  await expect(page.getByLabel("Label").last()).toHaveValue("New field")
  await page.getByLabel("Label").last().fill("Instructor")
  await page.getByRole("tab", { name: "Settings" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Training certificate")
  await page.getByRole("button", { name: "Create template" }).click()

  await expect(page.getByRole("heading", { name: "Training certificate" })).toBeVisible()
  await expect(page.getByText(/^Version 1\./)).toBeVisible()
  await page.getByRole("tab", { name: "Fields" }).click()
  await expect(page.getByLabel("Label").last()).toHaveValue("Instructor")
})

test("links from the old dashboard (#/…) still open the right page", async ({ page }) => {
  await signIn(page, "admin")
  await page.goto("/app#/templates")
  await expect(page).toHaveURL(/\/app\/templates$/)
  await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible()
})

// The PDF form editor: upload a form, draw a field, place the QR code, save, preview.
const { test, expect } = require("@playwright/test")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { signIn, nav, dialog } = require("./support")
const { makeSampleForm } = require("../scripts/make-sample-form")

let formPath
test.beforeAll(async () => {
  formPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cg-ui-")), "Pressure test form.pdf")
  fs.writeFileSync(formPath, await makeSampleForm())
})

test("upload a PDF form, draw a field, place the QR code, save and preview", async ({ page }) => {
  await signIn(page, "admin")
  await nav(page, "Templates")
  await page.getByRole("link", { name: "Add template" }).click()
  await page.getByRole("link", { name: /Upload your PDF form/ }).click()
  await expect(page.getByRole("heading", { name: "Upload your PDF form" })).toBeVisible()
  await page.locator('input[type="file"]').setInputFiles(formPath)

  await expect(page.getByRole("heading", { name: "Mark the fields on your form" })).toBeVisible()
  const overlay = page.locator(".pdf-overlay").first()
  await expect(page.locator("canvas.pdf-canvas").first()).toBeVisible()
  const box = await overlay.boundingBox()

  // Drag out a box, then say what goes in it.
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.23, { steps: 5 })
  await page.mouse.up()
  await expect(dialog(page).getByRole("heading", { name: "What goes in this box?" })).toBeVisible()
  await dialog(page).getByLabel("Name of the field").fill("Client name")
  await dialog(page).getByRole("button", { name: "Add" }).click()
  await expect(page.locator(".pbox", { hasText: "Client name" })).toBeVisible()
  await expect(page.locator(".pdf-side")).toContainText("Client name")

  // Place the QR code: choose it, then click on the page.
  const qrRow = page.locator(".fl-sub", { hasText: "QR code" })
  await qrRow.getByRole("button", { name: "place" }).click()
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.08)
  await expect(qrRow.getByRole("button", { name: "placed" })).toBeVisible()

  await page.getByRole("button", { name: "Create template" }).click()
  await expect(page.getByRole("button", { name: "Save new version" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Pressure test form" })).toBeVisible()

  await page.getByRole("button", { name: "Preview" }).click()
  await expect(dialog(page).getByRole("heading", { name: "Preview" })).toBeVisible()
  await expect(dialog(page).locator("canvas").first()).toBeVisible()
})

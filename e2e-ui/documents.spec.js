// The document lifecycle through the UI: draft, submit, approve by someone
// else, the PDF made in the background, partner verification, revocation.
const { test, expect } = require("@playwright/test")
const { appUrl, signIn, asUser, apiAs, nav, dialog } = require("./support")

const SCHEMA = [
  { key: "recipientName", label: "Recipient name", type: "text", required: true, showOnVerify: true },
  { key: "courseName", label: "Course", type: "text", required: true, showOnVerify: true },
  { key: "completedOn", label: "Completed on", type: "date", required: true },
]
const HTML = "<html><body><h1>{{org.name}}</h1><p>{{document.no}}</p><p>{{recipientName}} completed {{courseName}}</p>{{#if qr}}<img src=\"{{qr}}\">{{/if}}</body></html>"

test.beforeAll(async ({ playwright }, info) => {
  const admin = await apiAs(playwright, info.project.use.baseURL, "admin")
  const r = await admin.post("/api/templates", { data: { name: "Course certificate", html: HTML, schema: SCHEMA, settings: { numberPrefix: "CC-", numberPadding: 4 } } })
  expect(r.status()).toBe(201)
  await admin.dispose()
})

test("draft → submit → approve by someone else → PDF → verify → revoke", async ({ page, browser }) => {
  // The issuer prepares it.
  await signIn(page, "issuer")
  await nav(page, "Templates")
  const tile = page.locator(".tile", { hasText: "Course certificate" })
  await tile.getByRole("link", { name: "New document" }).click()
  await expect(page.getByRole("heading", { name: "New Course certificate" })).toBeVisible()
  await page.getByLabel("Recipient name").fill("Tunde Bello")
  await page.getByLabel("Course").fill("Working at Height")
  await page.getByLabel("Completed on").fill("2026-09-01")
  await page.getByRole("button", { name: "Save draft" }).first().click()

  await expect(page.getByRole("heading", { name: "CC-0001" })).toBeVisible()
  await expect(page.locator(".badge").first()).toHaveText("Draft")
  await page.getByRole("button", { name: "Submit for approval" }).click()
  await expect(page.locator(".badge").first()).toHaveText("Awaiting approval")
  await expect(page.getByText("Waiting for an approver")).toBeVisible()

  // The approver issues it.
  const { context, page: approver } = await asUser(browser, "approver")
  await approver.getByRole("link", { name: "CC-0001" }).click()
  await approver.getByRole("button", { name: "Approve & issue" }).click()
  await dialog(approver).getByRole("button", { name: "Approve & issue" }).click()
  await expect(approver.locator(".badge").first()).toHaveText("Issued")
  // The official PDF is made in the background; the page refreshes until it's ready.
  await expect(approver.getByRole("link", { name: "Download PDF" })).toBeVisible({ timeout: 45_000 })

  // A partner checks it.
  const verifyUrl = (await approver.locator(".card", { hasText: "Verification" }).locator(".mono").first().textContent()).trim()
  expect(verifyUrl).toMatch(/\/v\/[0-9A-Z]{24}$/)
  const partner = await browser.newPage()
  await partner.goto(verifyUrl.replace(/^https?:\/\/[^/]+/, ""))
  await expect(partner.getByRole("heading", { name: "Valid document" })).toBeVisible()
  await expect(partner.getByText("Tunde Bello")).toBeVisible()

  // The approver revokes it.
  await approver.getByRole("button", { name: "Revoke" }).click()
  await dialog(approver).getByLabel("Reason (shown publicly)").fill("Issued in error")
  await dialog(approver).getByRole("button", { name: "Revoke" }).click()
  await expect(approver.locator(".badge").first()).toHaveText("Revoked")
  await partner.reload()
  await expect(partner.getByRole("heading", { name: "Revoked — not valid" })).toBeVisible()
  await context.close()
})

test("the documents list filters by status and searches", async ({ page }) => {
  await signIn(page, "issuer")
  await expect(page.getByRole("link", { name: "CC-0001" })).toBeVisible()
  await page.getByRole("button", { name: /^Revoked/ }).click()
  await expect(page.getByRole("link", { name: "CC-0001" })).toBeVisible()
  await page.getByPlaceholder("Search number, company, item…").fill("nothing-matches-this")
  await page.getByPlaceholder("Search number, company, item…").press("Enter")
  await expect(page.getByText("No documents match.")).toBeVisible()
})

test("deep links work after signing in", async ({ page }) => {
  await signIn(page, "admin")
  await page.goto(appUrl("/settings"))
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Signing key" })).toBeVisible()
})

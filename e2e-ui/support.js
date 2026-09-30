// Shared helpers for the browser tests. Locators use what people see (labels,
// button text, headings), so the same tests check any version of the UI.
const { expect } = require("@playwright/test")

const USERS = {
  admin: { email: "admin@acme.test", password: "admin-password-1", name: "Ada Admin" },
  approver: { email: "approver@acme.test", password: "approver-password-1", name: "Paul Approver" },
  issuer: { email: "issuer@acme.test", password: "issuer-password-1", name: "Ivy Issuer" },
}

// The dashboards' addresses: hash routes (#/documents) or real paths (/documents).
const ROUTES = process.env.UI_ROUTES || "path"
const appUrl = (p = "/") => (ROUTES === "hash" ? `/app#${p}` : `/app${p === "/" ? "" : p}`)
const platformUrl = (p = "/") => (ROUTES === "hash" ? `/platform#${p}` : `/platform${p === "/" ? "" : p}`)

async function signIn(page, who) {
  const u = USERS[who]
  await page.goto(appUrl("/login"))
  await page.getByLabel("Email").fill(u.email)
  await page.getByLabel("Password", { exact: true }).fill(u.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Documents", exact: true })).toBeVisible()
}

// A fresh browser session signed in as someone else (e.g. the approver).
async function asUser(browser, who) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, who)
  return { context, page }
}

// Calls the API as a user (for setting things up quickly).
async function apiAs(playwright, baseURL, who) {
  const request = await playwright.request.newContext({ baseURL })
  const r = await request.post("/api/auth/login", { data: { email: USERS[who].email, password: USERS[who].password } })
  expect(r.ok()).toBeTruthy()
  return request
}

const nav = (page, name) => page.getByRole("navigation").getByRole("link", { name, exact: true }).click()
const dialog = (page) => page.getByRole("dialog")

module.exports = { USERS, appUrl, platformUrl, signIn, asUser, apiAs, nav, dialog }

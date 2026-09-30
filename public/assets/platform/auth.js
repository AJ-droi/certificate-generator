// Staff sign-in and authenticator-app setup.
import { busy, h, input, root, toast } from "../lib/dom.js"
import { go } from "../lib/router.js"
import { api } from "./api.js"
import { brand } from "./shell.js"
import { state } from "./state.js"

export function authCard(title, sub, body) {
  root.replaceChildren(h("div", { class: "auth-wrap" }, h("div", { class: "card auth-card" }, brand(), h("h1", {}, title), sub ? h("p", { class: "muted" }, sub) : null, body)))
}

export function loginScreen() {
  const err = h("div")
  const btn = h("button", { class: "btn primary", type: "submit" }, "Sign in")
  const form = h("form", {},
    input("email", "Email", { type: "email", autocomplete: "username", required: true }),
    input("password", "Password", { type: "password", autocomplete: "current-password", required: true }),
    input("code", "Authenticator code", { inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9 ]{6,7}", maxlength: 7 }, "Leave empty the first time you sign in"),
    err, btn)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    busy(btn, async () => {
      const r = await api("POST", "/auth/login", Object.fromEntries(new FormData(form).entries()))
      state.staff = r.staff
      go(r.setupRequired ? "#/setup" : "#/overview")
    }, err)
  })
  authCard("Platform staff", "For reviewing and verifying companies.", form)
  form.querySelector("input").focus()
}

export async function setupScreen() {
  const s = await api("POST", "/auth/setup/start", {})
  const err = h("div")
  const btn = h("button", { class: "btn primary", type: "submit" }, "Finish setup")
  const form = h("form", { class: "stack" },
    h("p", {}, "1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …)."),
    h("div", { class: "qr-box" }, h("img", { src: s.qr, alt: "QR code for your authenticator app" })),
    h("details", {}, h("summary", {}, "Can't scan? Enter this key instead"), h("div", { class: "secret" }, s.secret)),
    s.mustChangePassword
      ? input("newPassword", "2. Choose a new password", { type: "password", required: true, minlength: 12, autocomplete: "new-password" }, "At least 12 characters. Replaces your temporary password.")
      : null,
    input("code", `${s.mustChangePassword ? "3" : "2"}. Enter the 6-digit code the app shows`, { inputmode: "numeric", autocomplete: "one-time-code", required: true, pattern: "[0-9 ]{6,7}", maxlength: 7 }),
    err, btn)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    busy(btn, async () => {
      const r = await api("POST", "/auth/setup/finish", Object.fromEntries(new FormData(form).entries()))
      state.staff = r.staff
      toast("You're set up")
      go("#/overview", true)
    }, err)
  })
  authCard("Set up sign-in", "Staff accounts need an authenticator app. You'll enter a code from it every time you sign in.", form)
}

// Sign in, sign up, and choosing a new password.
import { busy, h, input, root, toast } from "../lib/dom.js"
import { api } from "./api.js"
import { go } from "../lib/router.js"
import { brand } from "./shell.js"
import { loadMe, state } from "./state.js"

export function authScreen(title, sub, fields, submitLabel, onSubmit, footer) {
  const err = h("div")
  const btn = h("button", { class: "btn primary", type: "submit" }, submitLabel)
  const form = h("form", {}, fields, err, btn)
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    busy(btn, () => onSubmit(Object.fromEntries(new FormData(form).entries())), err)
  })
  root.replaceChildren(
    h("div", { class: "auth-wrap" }, h("div", { class: "card auth-card" }, brand(), h("h1", {}, title), sub ? h("p", { class: "muted" }, sub) : null, form, footer)),
  )
  const first = form.querySelector("input")
  if (first) first.focus()
}

export function loginScreen() {
  authScreen(
    "Sign in",
    "Sign in to issue and manage your company's documents.",
    [input("email", "Email", { type: "email", autocomplete: "username", required: true }), input("password", "Password", { type: "password", autocomplete: "current-password", required: true })],
    "Sign in",
    async (data) => {
      await api("POST", "/api/auth/login", data)
      await loadMe()
      go(state.me.mustChangePassword ? "#/change-password" : "#/documents")
    },
    state.config.allowSignup ? h("p", { class: "muted", style: "margin-top:16px" }, "New company? ", h("a", { href: "#/signup" }, "Create an account")) : null,
  )
}

export function signupScreen() {
  authScreen(
    "Create your company account",
    "You'll be the admin. You can invite your team afterwards.",
    [
      input("orgName", "Company name", { required: true, autocomplete: "organization" }),
      input("name", "Your name", { required: true, autocomplete: "name" }),
      input("email", "Work email", { type: "email", required: true, autocomplete: "username" }),
      input("password", "Password", { type: "password", required: true, minlength: 10, autocomplete: "new-password" }, "At least 10 characters"),
    ],
    "Create account",
    async (data) => {
      await api("POST", "/api/auth/signup", data)
      await loadMe()
      go("#/templates")
      toast("Account created. Start by adding a template.")
    },
    h("p", { class: "muted", style: "margin-top:16px" }, "Already have an account? ", h("a", { href: "#/login" }, "Sign in")),
  )
}

export function changePasswordScreen() {
  authScreen(
    "Set a new password",
    state.me && state.me.mustChangePassword ? "You signed in with a temporary password. Choose your own to continue." : null,
    [
      input("currentPassword", "Current (temporary) password", { type: "password", required: true, autocomplete: "current-password" }),
      input("newPassword", "New password", { type: "password", required: true, minlength: 10, autocomplete: "new-password" }, "At least 10 characters"),
    ],
    "Save password",
    async (data) => {
      await api("POST", "/api/auth/password", data)
      await loadMe()
      toast("Password updated")
      go("#/documents")
    },
  )
}

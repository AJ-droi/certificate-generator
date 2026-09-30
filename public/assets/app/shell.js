// The page frame: sidebar, verification banner, page headings.
import { h, root } from "../lib/dom.js"
import { api } from "./api.js"
import { go } from "../lib/router.js"
import { isAdmin, state } from "./state.js"

export const ICON = {
  docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
  tmpl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5 5 0 0 1 3.5 6"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  shield: '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor" opacity=".15"/><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}
export const icon = (name) => h("span", { html: ICON[name], style: "display:inline-flex" })
export const brand = () => h("a", { class: "brand", href: "/" }, icon("shield"), h("span", {}, state.config.appName))

export function shell(active, ...content) {
  const nav = [
    ["documents", "Documents", "docs"],
    ["templates", "Templates", "tmpl"],
    ["users", "People", "users"],
    ["settings", "Settings", "settings"],
    isAdmin() ? ["audit", "Activity log", "audit"] : null,
  ].filter(Boolean)
  const app = h("div", { class: "app" })
  const sidebar = h(
    "aside",
    { class: "sidebar" },
    brand(),
    h("div", { class: "org-name", title: state.org.name }, state.org.name),
    h("nav", { class: "nav" }, nav.map(([key, label, ic]) =>
      h("a", { href: `#/${key}`, class: active === key ? "active" : "", onclick: () => app.classList.remove("nav-open") }, icon(ic), label),
    )),
    h(
      "div",
      { class: "me" },
      h("div", { style: "font-weight:600" }, state.me.name),
      h("div", { class: "muted" }, `${state.me.email} · ${state.me.role}`),
      h("button", { class: "btn small ghost", style: "margin-top:6px;padding:0", onclick: logout }, "Sign out"),
    ),
  )
  const bar = h(
    "div",
    { class: "mobile-bar" },
    h("button", { class: "btn ghost small", "aria-label": "Menu", onclick: () => app.classList.toggle("nav-open") }, icon("menu")),
    brand(),
  )
  app.append(sidebar, h("div", {}, bar, h("main", { class: "content" }, verificationBanner(), content)))
  root.replaceChildren(app)
}

// Until platform staff verify the company, nothing can be issued. Say so everywhere.
export function verificationBanner() {
  const v = state.org && state.org.verification
  if (!v || v.status === "verified") return null
  const toSettings = isAdmin() ? h("a", { href: "#/settings" }, "Go to verification") : null
  const byStatus = {
    unverified: ["warn", "Your company isn't verified yet, so documents can't be issued. ",
      isAdmin() ? toSettings : "Ask an admin to request verification in Settings."],
    pending: ["info", "Verification requested — we're checking your company's details. You can prepare documents, but they can't be issued yet. ",
      !v.domainVerified && isAdmin() ? h("a", { href: "#/settings" }, "Add your DNS record to speed this up") : null],
    rejected: ["bad", `Verification wasn't approved: ${v.note || "no reason given"}. `,
      isAdmin() ? h("a", { href: "#/settings" }, "Correct your details") : null],
    suspended: ["bad", `Your company has been suspended: ${v.note || "no reason given"}. Documents can't be issued, and documents already issued show as not valid. Contact support.`, null],
  }
  const [cls, text, extra] = byStatus[v.status] || byStatus.unverified
  return h("div", { class: `notice ${cls}`, role: "status", style: "margin-bottom:16px" }, text, extra)
}

export function pageHead(title, sub, ...actions) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "spacer" }), h("div", { class: "row head-actions" }, actions))
}

export async function logout() {
  await api("POST", "/api/auth/logout", {}).catch(() => {})
  state.me = null
  go("#/login")
}

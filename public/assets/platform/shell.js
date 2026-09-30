// The page frame, status badges and date formats.
import { h, root } from "../lib/dom.js"
import { go } from "../lib/router.js"
import { api } from "./api.js"
import { state } from "./state.js"

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"
export const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—")

export const STATUS = {
  pending: ["pending_approval", "Waiting for review"],
  unverified: ["draft", "Not applied"],
  verified: ["issued", "Verified"],
  rejected: ["superseded", "Rejected"],
  suspended: ["revoked", "Suspended"],
}
export const statusBadge = (s) => {
  const [cls, label] = STATUS[s] || [s, s]
  return h("span", { class: `badge ${cls}` }, label)
}
export const VERDICT = { valid: "Valid", tampered: "Failed integrity check", revoked: "Revoked", superseded: "Superseded", issuer_unverified: "Issuer not verified", issuer_suspended: "Issuer suspended" }

export const ICON = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  companies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16"/><path d="M15 9h3a2 2 0 0 1 2 2v10"/><path d="M3 21h18M8 7h3M8 11h3M8 15h3"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  shield: '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor" opacity=".15"/><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}
export const icon = (name) => h("span", { html: ICON[name], style: "display:inline-flex" })
export const brand = () => h("a", { class: "brand", href: "#/overview" }, icon("shield"), h("span", {}, state.appName))

export function shell(active, ...content) {
  const nav = [["overview", "Overview"], ["companies", "Companies"], ["activity", "Activity log"]]
  const app = h("div", { class: "app" })
  const sidebar = h("aside", { class: "sidebar" },
    brand(),
    h("div", { class: "org-name" }, "Platform staff"),
    h("nav", { class: "nav" }, nav.map(([key, label]) =>
      h("a", { href: `#/${key}`, class: active === key ? "active" : "", onclick: () => app.classList.remove("nav-open") }, icon(key), label))),
    h("div", { class: "me" },
      h("div", { style: "font-weight:600" }, state.staff.name),
      h("div", { class: "muted" }, state.staff.email),
      h("button", { class: "btn small ghost", style: "margin-top:6px;padding:0", onclick: logout }, "Sign out")))
  const bar = h("div", { class: "mobile-bar" },
    h("button", { class: "btn ghost small", "aria-label": "Menu", onclick: () => app.classList.toggle("nav-open") }, icon("menu")),
    brand())
  app.append(sidebar, h("div", {}, bar, h("main", { class: "content" }, content)))
  root.replaceChildren(app)
}

export const pageHead = (title, sub, ...actions) =>
  h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "spacer" }), h("div", { class: "row head-actions" }, actions))

export async function logout() {
  await api("POST", "/auth/logout", {}).catch(() => {})
  state.staff = null
  go("#/login", true)
}

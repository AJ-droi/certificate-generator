// Signed-in person, their company, and small shared helpers.
import { h } from "../lib/dom.js"
import { api } from "./api.js"

export const state = { me: null, org: null, config: { appName: "DocTrust", allowSignup: true }, templates: null }

export const STATUS_LABEL = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  issued: "Issued",
  revoked: "Revoked",
  superseded: "Superseded",
}
export const badge = (status) => h("span", { class: `badge ${status}` }, STATUS_LABEL[status] || status)
export const isAdmin = () => state.me && state.me.role === "admin"
export const orgVerified = () => state.org && state.org.verification && state.org.verification.status === "verified"
export const NOT_VERIFIED_TITLE = "Your company must be verified before documents can be issued"
export const canApprove = () => state.me && ["admin", "approver"].includes(state.me.role)

export async function loadTemplates(force) {
  if (!state.templates || force) state.templates = (await api("GET", "/api/templates")).templates
  return state.templates
}

export async function loadMe() {
  try {
    const r = await api("GET", "/api/auth/me")
    state.me = r.user
    state.org = r.organization
  } catch {
    state.me = null
    state.org = null
  }
}

// People: invite, change roles, reset passwords.
import { h, modal, showSecret, toast } from "../lib/dom.js"
import { api } from "./api.js"
import { pageHead, shell } from "./shell.js"
import { isAdmin, state } from "./state.js"

export async function usersScreen() {
  shell("users", h("p", { class: "loading" }, "Loading…"))
  const { users } = await api("GET", "/api/users")
  const ROLE_HELP = { admin: "Everything, incl. templates & people", approver: "Approves, issues and revokes", issuer: "Prepares documents" }
  const roleSelect = (name, value) => h("select", { name }, ["issuer", "approver", "admin"].map((r) => h("option", { value: r, selected: r === value ? true : null }, `${r} — ${ROLE_HELP[r]}`)))

  const add = isAdmin() ? h("button", { class: "btn primary", onclick: async () => {
    const data = await modal("Add a person", [
      h("label", { class: "field" }, h("span", {}, "Name"), h("input", { name: "name", required: true })),
      h("label", { class: "field" }, h("span", {}, "Email"), h("input", { name: "email", type: "email", required: true })),
      h("label", { class: "field" }, h("span", {}, "Role"), roleSelect("role", "issuer")),
    ], { submitLabel: "Add" })
    if (!data) return
    try {
      const r = await api("POST", "/api/users", data)
      await showSecret("Share this temporary password", `Give ${r.user.name} this password. They'll choose their own when they first sign in. It won't be shown again.`, r.temporaryPassword)
      usersScreen()
    } catch (e) { toast(e.message, true) }
  } }, "Add person") : null

  shell("users",
    pageHead("People", "Who can prepare, approve and manage documents.", add),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Role"), h("th", {}, "Signature"), h("th", {}, "Status"), isAdmin() ? h("th") : null)),
      h("tbody", {}, users.map((u) => h("tr", {},
        h("td", {}, h("div", { style: "font-weight:600" }, u.name), h("div", { class: "muted", style: "font-size:.85rem" }, u.email)),
        h("td", {}, isAdmin() && u.id !== state.me.id
          ? h("select", { style: "min-width:120px", onchange: async (e) => { try { await api("PATCH", `/api/users/${u.id}`, { role: e.target.value }); toast("Role updated") } catch (er) { toast(er.message, true); usersScreen() } } },
              ["issuer", "approver", "admin"].map((r) => h("option", { value: r, selected: r === u.role ? true : null }, r)))
          : u.role),
        h("td", {}, u.signature ? h("img", { src: u.signature, alt: "", style: "height:28px;background:#fff;border-radius:4px" }) : h("span", { class: "muted" }, "—")),
        h("td", {}, u.active ? (u.mustChangePassword ? h("span", { class: "badge pending_approval" }, "Invited") : h("span", { class: "badge issued" }, "Active")) : h("span", { class: "badge" }, "Deactivated")),
        isAdmin() ? h("td", { style: "text-align:right" }, u.id === state.me.id ? null : h("div", { class: "row", style: "justify-content:flex-end" },
          h("button", { class: "btn small", onclick: async () => {
            if (!(await modal(`Reset ${u.name}'s password?`, [h("p", {}, "They'll get a new temporary password and be signed out.")], { submitLabel: "Reset" }))) return
            try { const r = await api("POST", `/api/users/${u.id}/reset-password`, {}); await showSecret("New temporary password", `Give this to ${u.name}.`, r.temporaryPassword); usersScreen() } catch (e) { toast(e.message, true) }
          } }, "Reset password"),
          h("button", { class: `btn small ${u.active ? "danger" : ""}`, onclick: async () => {
            try { await api("PATCH", `/api/users/${u.id}`, { active: !u.active }); toast(u.active ? "Deactivated" : "Reactivated"); usersScreen() } catch (e) { toast(e.message, true) }
          } }, u.active ? "Deactivate" : "Reactivate"),
        )) : null,
      ))),
    )),
    h("p", { class: "muted", style: "margin-top:12px;font-size:.9rem" }, "Each person adds their own signature in Settings. It's placed on a document only when they prepare or approve it."),
  )
}

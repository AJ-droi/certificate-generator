// The company's activity log.
import { fmtDate, h } from "../lib/dom.js"
import { api } from "./api.js"
import { pageHead, shell } from "./shell.js"

export async function auditScreen() {
  shell("audit", h("p", { class: "loading" }, "Loading…"))
  const { events } = await api("GET", "/api/audit?limit=300")
  shell("audit",
    pageHead("Activity log", "Everything that happened in your account, newest first. Entries can't be edited."),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "What"), h("th", {}, "Details"))),
      h("tbody", {}, events.map((e) => h("tr", {},
        h("td", { class: "muted", style: "white-space:nowrap" }, fmtDate(e.createdAt)),
        h("td", {}, e.userName || "—"),
        h("td", {}, e.entityType === "document" && e.entityId ? h("a", { href: `#/documents/${e.entityId}` }, e.action) : e.action),
        h("td", { class: "muted", style: "font-size:.85rem;max-width:380px;overflow-wrap:anywhere" },
          Object.entries(e.details || {}).filter(([k]) => !["userAgent", "contentHash", "pdfHash"].includes(k)).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ")),
      ))),
    )),
  )
}

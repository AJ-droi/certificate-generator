// Staff sign-ins and verification decisions.
import { h } from "../lib/dom.js"
import { api } from "./api.js"
import { detailText } from "./companies.js"
import { fmtDate, pageHead, shell } from "./shell.js"

export async function activityScreen() {
  shell("activity", h("p", { class: "loading" }, "Loading…"))
  const { events } = await api("GET", "/activity?limit=300")
  shell("activity",
    pageHead("Activity log", "Staff sign-ins and every verification request and decision, newest first."),
    h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "What"), h("th", {}, "Company"), h("th", {}, "Details"))),
      h("tbody", {}, events.map((e) => h("tr", {},
        h("td", { class: "muted", style: "white-space:nowrap" }, fmtDate(e.createdAt)),
        h("td", {}, e.who),
        h("td", {}, e.action),
        h("td", {}, e.organizationId ? h("a", { href: `#/companies/${e.organizationId}` }, e.organizationName || "—") : "—"),
        h("td", { class: "muted", style: "font-size:.85rem;max-width:360px;overflow-wrap:anywhere" }, [detailText(e.details), e.ip ? ` · ip: ${e.ip}` : ""].join(""))))))))
}

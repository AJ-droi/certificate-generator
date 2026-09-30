// Overview, the company list, and one company's page with its verification actions.
import { busy, h, input, modal, toast } from "../lib/dom.js"
import { go } from "../lib/router.js"
import { api } from "./api.js"
import { VERDICT, fmtDate, fmtDay, pageHead, shell, statusBadge } from "./shell.js"

export const stat = (num, label, { href, cls } = {}) =>
  h(href ? "a" : "div", { class: `stat ${cls || ""}`, href }, h("div", { class: "num" }, num.toLocaleString()), h("div", { class: "label" }, label))

export function companyTable(rows, cols) {
  return h("div", { class: "table-wrap" }, h("table", { class: "data" },
    h("thead", {}, h("tr", {}, cols.map(([label, , cls]) => h("th", { class: cls }, label)))),
    h("tbody", {}, rows.map((c) => h("tr", { class: "clickable", onclick: () => go(`#/companies/${c.id}`, true) },
      cols.map(([, cell, cls]) => h("td", { class: cls }, cell(c))))))))
}

export const nameCell = (c) => h("div", {}, h("div", { style: "font-weight:600" }, c.legalName || c.name), h("div", { class: "muted", style: "font-size:.85rem" }, c.legalName && c.legalName !== c.name ? `${c.name} · ${c.slug}` : c.slug))
export const domainCell = (c) => (c.domain ? h("span", {}, c.domain, " ", c.domainVerified ? h("span", { title: "DNS record found", style: "color:var(--ok)" }, "✓") : h("span", { class: "muted", title: "Not proven yet" }, "(not proven)")) : "—")

export async function overviewScreen() {
  shell("overview", h("p", { class: "loading" }, "Loading…"))
  const { stats, pending, flagged } = await api("GET", "/overview")
  const c = stats.companies
  shell("overview",
    pageHead("Overview", "Companies waiting for review, and signs something is wrong."),
    h("div", { class: "stack" },
      h("div", { class: "stat-grid" },
        stat(c.pending, "Waiting for review", { href: "#/companies?status=pending", cls: c.pending ? "attention" : "" }),
        stat(c.verified, "Verified companies", { href: "#/companies?status=verified" }),
        stat(c.unverified + c.rejected, "Not verified", { href: "#/companies?status=unverified" }),
        stat(c.suspended, "Suspended", { href: "#/companies?status=suspended", cls: c.suspended ? "alert" : "" }),
        stat(stats.documents.issued30, "Documents issued (30 days)"),
        stat(stats.scans.scans30, "QR scans (30 days)"),
        stat(stats.scans.invalid30, "Scans of invalid documents (30 days)", { href: "#/companies?sort=invalid", cls: stats.scans.invalid30 ? "alert" : "" })),
      h("section", { class: "stack" },
        h("h2", {}, "Waiting for review"),
        pending.length
          ? companyTable(pending, [
              ["Company", nameCell],
              ["Domain", domainCell],
              ["Requested", (x) => fmtDate(x.requestedAt), "nowrap"],
              ["Signed up", (x) => fmtDay(x.createdAt), "nowrap"],
            ])
          : h("div", { class: "card empty" }, "Nothing waiting. 🎉")),
      h("section", { class: "stack" },
        h("h2", {}, "Invalid documents being presented"),
        h("p", { class: "muted" }, "Partners scanned these companies' documents and got anything other than \"Valid\" — tampered, revoked, replaced, or from an unverified issuer. A spike can mean someone is using forged or cancelled documents."),
        flagged.length
          ? companyTable(flagged, [
              ["Company", nameCell],
              ["Status", (x) => statusBadge(x.status)],
              ["Invalid scans", (x) => h("strong", { style: "color:var(--bad)" }, x.invalid30), "num-cell"],
              ["All scans", (x) => x.scans30, "num-cell"],
            ])
          : h("div", { class: "card empty" }, "No invalid scans in the last 30 days."))))
}

export async function companiesScreen(params) {
  const status = params.get("status") || ""
  const q = params.get("q") || ""
  const sort = params.get("sort") || ""
  shell("companies", h("p", { class: "loading" }, "Loading…"))
  const { companies } = await api("GET", `/companies?${new URLSearchParams({ status, q, sort })}`)
  const link = (over) => `#/companies?${new URLSearchParams({ status, q, sort, ...over })}`
  const tabs = h("div", { class: "tabs" },
    [["", "All"], ["pending", "Waiting for review"], ["verified", "Verified"], ["unverified", "Not applied"], ["rejected", "Rejected"], ["suspended", "Suspended"]].map(([s, label]) =>
      h("button", { class: s === status ? "active" : "", onclick: () => go(link({ status: s })) }, label)))
  const search = h("input", { type: "search", placeholder: "Search name, ID, domain, registration no.…", value: q, style: "max-width:360px" })
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(link({ q: search.value }))
  })
  shell("companies",
    pageHead("Companies", `${companies.length}${companies.length === 200 ? "+" : ""} shown`),
    tabs,
    h("div", { class: "row", style: "margin-bottom:12px" }, search,
      h("label", { class: "check", style: "font-weight:400" }, h("input", { type: "checkbox", checked: sort === "invalid", onchange: (e) => go(link({ sort: e.target.checked ? "invalid" : "" })) }), "Most invalid scans first")),
    companies.length
      ? companyTable(companies, [
          ["Company", nameCell],
          ["Status", (c) => statusBadge(c.status)],
          ["Domain", domainCell],
          ["People", (c) => c.users, "num-cell"],
          ["Issued", (c) => c.issued, "num-cell"],
          ["Invalid scans (30d)", (c) => (c.invalid30 ? h("strong", { style: "color:var(--bad)" }, c.invalid30) : "0"), "num-cell"],
          ["Signed up", (c) => fmtDay(c.createdAt), "nowrap"],
        ])
      : h("div", { class: "card empty" }, "No companies match."))
}

export async function companyScreen(id) {
  shell("companies", h("p", { class: "loading" }, "Loading…"))
  const d = await api("GET", `/companies/${id}`)
  const org = d.organization
  const v = org.verification
  const err = h("div")
  const reload = () => companyScreen(id)

  const act = (label, cls, fn) => {
    const b = h("button", { class: `btn ${cls || ""}`, onclick: () => busy(b, fn, err) }, label)
    return b
  }

  const verify = act(v.status === "suspended" ? "Reinstate" : "Verify company", "primary", async () => {
    const answer = await modal(v.status === "suspended" ? "Reinstate this company?" : "Verify this company?", [
      h("p", { class: "muted" }, "Partners will see these details on every document the company issues. Correct anything that doesn't match the registry."),
      h("div", { class: "grid-2" },
        input("legalName", "Registered name", { value: v.legalName || org.name, required: true }),
        input("registrationNumber", "Registration number", { value: v.registrationNumber || "", required: true }),
        input("registrationCountry", "Country (2-letter code)", { value: v.registrationCountry || "", required: true, maxlength: 2, style: "text-transform:uppercase" }),
        input("domain", "Website domain", { value: v.domain || "", required: true })),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "registryChecked" }),
        "I checked the name and registration number with the official company registry, and that the person who applied works there."),
      v.domainVerified
        ? h("p", { class: "muted" }, `✓ ${v.domain} proven by DNS record.`)
        : h("label", { class: "check" }, h("input", { type: "checkbox", name: "trustDomain" }),
            `The DNS record for ${v.domain || "the domain"} isn't there. I confirmed they control it another way (e.g. email to an address on the domain).`),
    ], {
      submitLabel: v.status === "suspended" ? "Reinstate" : "Verify",
      validate: (x) => {
        if (!x.registryChecked) throw new Error("Tick the box to confirm you checked the registry")
      },
    })
    if (!answer) return
    await api("POST", `/companies/${id}/verify`, { ...answer, registrationCountry: String(answer.registrationCountry || "").toUpperCase() })
    toast("Company verified")
    reload()
  })
  const reject = act("Reject", "danger", async () => {
    const answer = await modal("Reject this request?", [
      h("label", { class: "field" }, h("span", {}, "Reason (the company sees this)"), h("textarea", { name: "reason", rows: 3, required: true, placeholder: "e.g. The registration number doesn't match the company name" })),
    ], { submitLabel: "Reject", danger: true })
    if (!answer) return
    await api("POST", `/companies/${id}/reject`, answer)
    toast("Request rejected")
    reload()
  })
  const suspend = act("Suspend", "danger", async () => {
    const answer = await modal("Suspend this company?", [
      h("p", {}, "It won't be able to issue documents, and every document it has issued will show as ", h("strong", {}, "Issuer suspended — not valid"), " when scanned. It can still revoke documents."),
      h("label", { class: "field" }, h("span", {}, "Reason (the company sees this)"), h("textarea", { name: "reason", rows: 3, required: true })),
    ], { submitLabel: "Suspend", danger: true })
    if (!answer) return
    await api("POST", `/companies/${id}/suspend`, answer)
    toast("Company suspended")
    reload()
  })
  const checkDns = act("Check DNS now", "", async () => {
    const r = await api("POST", `/companies/${id}/check-dns`, {})
    toast(r.found ? "DNS record found — domain proven" : "DNS record not found", !r.found)
    reload()
  })

  const actions = []
  if (v.dnsRecord && !v.domainVerified && v.status !== "verified") actions.push(checkDns)
  if (["pending", "unverified", "rejected"].includes(v.status)) actions.push(reject, verify)
  if (v.status === "verified") actions.push(suspend)
  if (v.status === "suspended") actions.push(verify)

  // Things to look at before verifying (or signs of abuse after).
  const warnings = []
  if (d.warnings.similar.length) {
    warnings.push(h("li", {}, "The name looks like verified companies — check this isn't an impersonation: ",
      d.warnings.similar.map((o, i) => [i ? ", " : "", h("a", { href: `#/companies/${o.id}` }, o.name), ` (${o.domain})`])))
  }
  if (d.warnings.adminsOffDomain.length) warnings.push(h("li", {}, `Admin email not on ${v.domain}: ${d.warnings.adminsOffDomain.join(", ")}`))
  if (v.domain && !v.domainVerified) warnings.push(h("li", {}, `${v.domain} hasn't been proven with its DNS record.`))
  const invalid = Object.entries(d.scans30).filter(([k]) => k !== "valid").reduce((a, [, n]) => a + n, 0)
  if (invalid) warnings.push(h("li", {}, `${invalid} scan${invalid === 1 ? "" : "s"} of invalid documents in the last 30 days.`))

  const kv = (pairs) => h("dl", { class: "kv" }, pairs.filter(Boolean).map(([k, val]) => [h("dt", {}, k), h("dd", {}, val === null || val === undefined || val === "" ? "—" : val)]))
  const docs = d.documents
  const scans = Object.entries(d.scans30)

  shell("companies",
    pageHead(v.legalName || org.name, h("span", { class: "row" }, statusBadge(v.status), h("span", { class: "mono" }, org.slug)), actions),
    err,
    v.note && ["rejected", "suspended"].includes(v.status) ? h("div", { class: "notice bad", style: "margin-bottom:16px" }, h("strong", {}, v.status === "suspended" ? "Suspended: " : "Rejected: "), v.note) : null,
    warnings.length ? h("div", { class: "notice warn", style: "margin-bottom:16px" }, h("strong", {}, "Check before trusting"), h("ul", { class: "warn-list" }, warnings)) : null,
    h("div", { class: "grid-2", style: "align-items:start" },
      h("section", { class: "card stack" },
        h("h2", {}, "Identity"),
        kv([
          ["Name on account", org.name],
          ["Registered name", v.legalName],
          ["Registration no.", v.registrationNumber ? `${v.registrationNumber} (${v.registrationCountry})` : null],
          ["Website domain", v.domain ? `${v.domain} ${v.domainVerified ? "✓ proven" : "— not proven"}` : null],
          v.dnsRecord && !v.domainVerified ? ["DNS record", h("span", { class: "mono" }, `${v.dnsRecord.name} TXT "${v.dnsRecord.value}"`)] : null,
          ["Signed up", fmtDate(org.createdAt)],
          ["Requested", fmtDate(v.requestedAt)],
          ["Verified", v.verifiedAt ? `${fmtDate(v.verifiedAt)} by ${org.verifiedBy}` : null],
          ["Signing key", h("span", { class: "mono" }, org.keyId)],
        ])),
      h("section", { class: "card stack" },
        h("h2", {}, "Usage"),
        kv([
          ["Templates", String(d.templates)],
          ["Issued", String((docs.issued || 0) + (docs.revoked || 0) + (docs.superseded || 0))],
          ["Revoked", String(docs.revoked || 0)],
          ["Drafts / waiting", `${docs.draft || 0} / ${docs.pending_approval || 0}`],
          ["Scans (30 days)", scans.length ? scans.map(([k, n]) => `${VERDICT[k] || k}: ${n}`).join(" · ") : "None"],
        ]))),
    h("section", { class: "stack", style: "margin-top:20px" },
      h("h2", {}, "People"),
      h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Email"), h("th", {}, "Role"), h("th", {}, "Added"))),
        h("tbody", {}, d.users.map((u) => h("tr", {},
          h("td", {}, u.name, u.active ? "" : h("span", { class: "muted" }, " (disabled)")),
          h("td", {}, u.email),
          h("td", {}, u.role),
          h("td", { class: "muted" }, fmtDay(u.createdAt)))))))),
    d.recentDocuments.length
      ? h("section", { class: "stack", style: "margin-top:20px" },
          h("h2", {}, "Recent documents"),
          h("p", { class: "muted" }, "Numbers and status only. Issued ones link to their public verify page."),
          h("div", { class: "table-wrap" }, h("table", { class: "data" },
            h("thead", {}, h("tr", {}, h("th", {}, "Number"), h("th", {}, "Status"), h("th", {}, "Issued"))),
            h("tbody", {}, d.recentDocuments.map((doc) => h("tr", {},
              h("td", {}, doc.publicId ? h("a", { href: `/v/${doc.publicId}`, target: "_blank", rel: "noopener" }, doc.documentNo) : doc.documentNo),
              h("td", {}, doc.status.replace("_", " ")),
              h("td", { class: "muted" }, fmtDate(doc.issuedAt))))))))
      : null,
    h("section", { class: "stack", style: "margin-top:20px" },
      h("h2", {}, "Recent activity"),
      h("div", { class: "table-wrap" }, h("table", { class: "data" },
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Who"), h("th", {}, "What"), h("th", {}, "Details"))),
        h("tbody", {}, d.events.map((e) => h("tr", {},
          h("td", { class: "muted", style: "white-space:nowrap" }, fmtDate(e.createdAt)),
          h("td", {}, e.who),
          h("td", {}, e.action),
          h("td", { class: "muted", style: "font-size:.85rem;max-width:380px;overflow-wrap:anywhere" }, detailText(e.details)))))))),
  )
}

export const detailText = (details) =>
  Object.entries(details || {})
    .filter(([k]) => !["userAgent", "contentHash", "pdfHash", "staffId", "staff"].includes(k))
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join(" · ")

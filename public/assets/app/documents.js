// Documents: list, new, and the document page (approve, revoke, correct).
import { busy, fmtDate, h, modal, toast } from "../lib/dom.js"
import { api } from "./api.js"
import { buildForm } from "./form.js"
import { previewFrame } from "./pdf-view.js"
import { go } from "../lib/router.js"
import { pageHead, shell } from "./shell.js"
import { NOT_VERIFIED_TITLE, STATUS_LABEL, badge, canApprove, isAdmin, loadTemplates, orgVerified, state } from "./state.js"

export async function documentsScreen(params) {
  const status = params.get("status") || ""
  const q = params.get("q") || ""
  shell("documents", h("p", { class: "loading" }, "Loading…"))
  const [list, templates] = await Promise.all([
    api("GET", `/api/documents?${new URLSearchParams({ status, q, limit: 100 })}`),
    loadTemplates(),
  ])
  const tmplName = new Map(templates.map((t) => [t.id, t.name]))
  const active = templates.filter((t) => !t.archived)
  const total = Object.values(list.counts).reduce((a, b) => a + b, 0)

  const newBtn = h("button", {
    class: "btn primary",
    disabled: active.length === 0,
    onclick: async () => {
      if (active.length === 1) return go(`#/documents/new/${active[0].id}`)
      const picked = await modal("New document", [
        h("label", { class: "field" }, h("span", {}, "Template"), h("select", { name: "templateId" }, active.map((t) => h("option", { value: t.id }, t.name)))),
      ], { submitLabel: "Continue" })
      if (picked) go(`#/documents/new/${picked.templateId}`)
    },
  }, "New document")

  const tabs = h("div", { class: "tabs", role: "tablist" },
    [["", "All", total], ...Object.keys(STATUS_LABEL).map((s) => [s, STATUS_LABEL[s], list.counts[s] || 0])]
      .filter(([s, , n]) => s === "" || n > 0 || s === status)
      .map(([s, label, n]) =>
        h("button", { class: s === status ? "active" : "", onclick: () => go(`#/documents?${new URLSearchParams({ status: s, q })}`) }, label, h("span", { class: "count" }, n)),
      ),
  )

  const search = h("input", { type: "search", placeholder: "Search number, company, item…", value: q, style: "max-width:320px" })
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go(`#/documents?${new URLSearchParams({ status, q: search.value })}`)
  })

  let body
  if (templates.length === 0) {
    body = h("div", { class: "card empty" }, h("h2", {}, "Add your first template"), h("p", {}, "Templates are your certificate and report layouts. Add one, then you can start issuing documents."), isAdmin() ? h("a", { class: "btn primary", href: "#/templates/add" }, "Add a template") : h("p", {}, "Ask an admin to add one."))
  } else if (list.documents.length === 0) {
    body = h("div", { class: "card empty" }, q || status ? "No documents match." : "No documents yet.")
  } else {
    body = h("div", { class: "table-wrap" }, h("table", { class: "data" },
      h("thead", {}, h("tr", {}, h("th", {}, "Number"), h("th", {}, "Template"), h("th", {}, "Status"), h("th", {}, "Updated"))),
      h("tbody", {}, list.documents.map((d) =>
        h("tr", { class: "clickable", onclick: () => go(`#/documents/${d.id}`) },
          h("td", {}, h("a", { href: `#/documents/${d.id}`, style: "font-weight:600" }, d.documentNo)),
          h("td", {}, tmplName.get(d.templateId) || "—"),
          h("td", {}, badge(d.status)),
          h("td", { class: "muted" }, fmtDate(d.updatedAt)),
        ),
      )),
    ))
  }

  shell("documents",
    pageHead("Documents", `${total} total`, newBtn),
    h("div", { class: "row", style: "margin-bottom:12px" }, tabs, h("div", { class: "spacer" }), search),
    body,
    list.total > list.documents.length ? h("p", { class: "muted", style: "margin-top:10px" }, `Showing ${list.documents.length} of ${list.total}. Search to narrow down.`) : null,
  )
}

export async function newDocumentScreen(templateId) {
  shell("documents", h("p", { class: "loading" }, "Loading…"))
  const { template, version } = await api("GET", `/api/templates/${templateId}`)
  const form = buildForm(version.schema, {})
  const err = h("div")
  const docNo = h("input", { placeholder: `Leave blank to number automatically (${version.settings.numberPrefix || ""}${"#".repeat(version.settings.numberPadding || 4)})` })
  const doSave = (btn) => busy(btn, async () => {
    const res = await api("POST", "/api/documents", { templateId, data: form.values(), documentNo: docNo.value.trim() || undefined })
    toast("Draft saved")
    go(`#/documents/${res.document.id}`)
  }, err)
  const saveBtn = () => { const b = h("button", { class: "btn primary", onclick: () => doSave(b) }, "Save draft"); return b }
  const hasSample = Object.values(version.settings.sampleData || {}).some((v) => v !== "" && v !== false && v !== null && !(Array.isArray(v) && !v.length))
  const sampleBtn = hasSample
    ? h("button", { class: "btn", onclick: () => { const f = buildForm(version.schema, version.settings.sampleData); form.el.replaceWith(f.el); Object.assign(form, f) } }, "Fill with sample data")
    : null
  shell("documents",
    pageHead(`New ${template.name}`, "Fill in the details and save a draft. Nothing is official until it's approved and issued.", sampleBtn, saveBtn()),
    h("div", { class: "stack" },
      h("div", { class: "card" }, h("label", { class: "field", style: "max-width:420px" }, h("span", {}, "Document number"), docNo)),
      h("div", { class: "card" }, form.el),
      err,
      h("div", { class: "row" }, h("div", { class: "spacer" }), saveBtn()),
    ),
  )
}

export async function documentScreen(id) {
  shell("documents", h("p", { class: "loading" }, "Loading…"))
  const res = await api("GET", `/api/documents/${id}`)
  const { document: doc, template, version, related, people, history, verifyUrl } = res
  const mine = doc.createdBy === state.me.id
  const editable = doc.status === "draft" && (mine || isAdmin())
  const err = h("div")
  const { box: frameBox, show: showPreview } = previewFrame("Document preview")
  const loadPreview = async () => showPreview(await api("GET", `/api/documents/${id}/render`))

  const act = (label, path, opts = {}) => {
    const b = h("button", { class: `btn ${opts.cls || ""}`, onclick: () => busy(b, async () => {
      let body = {}
      if (opts.confirm) {
        const answer = await modal(opts.confirm.title, opts.confirm.body, { submitLabel: opts.confirm.submit, danger: opts.confirm.danger })
        if (!answer) return
        body = answer
      }
      const out = await api("POST", `/api/documents/${id}/${path}`, body)
      toast(opts.done || "Done")
      go(`#/documents/${out.document.id}`, true)
    }, err) }, label)
    return b
  }

  const actions = []
  // The official PDF is made in the background after issuing.
  const pdfAction = () => {
    if (doc.pdfStatus === "pending") {
      // Check again shortly, while this document is still on screen.
      setTimeout(() => {
        if (location.hash === `#/documents/${id}`) go(`#/documents/${id}`, true)
      }, 3000)
      return h("button", { class: "btn", disabled: true, title: "The official PDF is being made" }, "Preparing PDF…")
    }
    if (doc.pdfStatus === "failed") {
      return canApprove()
        ? act("Try making the PDF again", "retry-pdf", { done: "Making the PDF again" })
        : h("button", { class: "btn", disabled: true, title: "Ask an approver to try again" }, "PDF failed")
    }
    return h("a", { class: "btn", href: `/api/documents/${id}/pdf` }, "Download PDF")
  }
  let formApi = null
  if (editable) {
    formApi = buildForm(version.schema, doc.data)
    const docNo = h("input", { value: doc.documentNo })
    const save = h("button", { class: "btn", onclick: () => busy(save, async () => {
      await api("PATCH", `/api/documents/${id}`, { data: formApi.values(), documentNo: docNo.value.trim() })
      toast("Saved")
      await loadPreview()
    }, err) }, "Save")
    const submit = h("button", { class: "btn primary", onclick: () => busy(submit, async () => {
      await api("PATCH", `/api/documents/${id}`, { data: formApi.values(), documentNo: docNo.value.trim() })
      await api("POST", `/api/documents/${id}/submit`, {})
      toast("Sent for approval")
      go(`#/documents/${id}`, true)
    }, err) }, "Submit for approval")
    const del = h("button", { class: "btn danger", onclick: () => busy(del, async () => {
      if (!(await modal("Delete this draft?", [h("p", {}, "This can't be undone.")], { submitLabel: "Delete", danger: true }))) return
      await api("DELETE", `/api/documents/${id}`)
      toast("Draft deleted")
      go("#/documents")
    }, err) }, "Delete")
    actions.push(del, save, submit)
    if (!state.org.requireSeparateApprover && canApprove() && mine) {
      const issue = act("Approve & issue", "approve", {
        cls: "primary",
        done: "Issued",
        confirm: { title: "Issue this document?", body: [h("p", {}, "It will be signed, locked and given a QR code. After this, changes need a correction.")], submit: "Issue" },
      })
      if (!orgVerified()) {
        issue.disabled = true
        issue.title = NOT_VERIFIED_TITLE
      }
      actions.push(issue)
    }
    formApi.docNoInput = docNo
  }
  if (doc.status === "pending_approval" && canApprove()) {
    const selfBlocked = state.org.requireSeparateApprover && mine
    actions.push(act("Send back", "send-back", {
      done: "Sent back to draft",
      confirm: { title: "Send back for changes", body: [h("label", { class: "field" }, h("span", {}, "What needs changing?"), h("textarea", { name: "note", rows: 3 }))], submit: "Send back" },
    }))
    const approve = act("Approve & issue", "approve", {
      cls: "primary",
      done: "Issued — signed and locked",
      confirm: { title: "Approve and issue?", body: [h("p", {}, "Your name and signature go on the document. It will be signed, locked and given a QR code that partners can check.")], submit: "Approve & issue" },
    })
    if (selfBlocked) {
      approve.disabled = true
      approve.title = "Someone else must approve a document you prepared"
    } else if (!orgVerified()) {
      approve.disabled = true
      approve.title = NOT_VERIFIED_TITLE
    }
    actions.push(approve)
  }
  if (doc.status === "issued") {
    actions.push(pdfAction())
    const hasCorrection = related.some((r) => r.supersedesId === doc.id)
    if (!hasCorrection) actions.push(act("Start correction", "correct", { done: "Correction draft created" }))
    if (canApprove()) {
      actions.push(act("Revoke", "revoke", {
        cls: "danger",
        done: "Revoked",
        confirm: {
          title: "Revoke this document?",
          body: [h("p", {}, "Anyone who checks it will see it's no longer valid, with your reason."), h("label", { class: "field" }, h("span", {}, "Reason (shown publicly)"), h("textarea", { name: "reason", rows: 3, required: true }))],
          submit: "Revoke",
          danger: true,
        },
      }))
    }
  }
  if (["revoked", "superseded"].includes(doc.status) && doc.pdfPath) {
    actions.push(pdfAction())
  }

  const relatedLinks = related.map((r) =>
    h("div", {}, r.id === doc.supersedesId ? "Corrects " : r.supersedesId === doc.id ? "Corrected by " : "Related: ", h("a", { href: `#/documents/${r.id}` }, r.documentNo), " ", badge(r.status)),
  )

  const details = h("div", { class: "card" }, h("h3", {}, "Details"), h("dl", { class: "kv" },
    h("dt", {}, "Template"), h("dd", {}, `${template.name} (v${version.version})`),
    h("dt", {}, "Prepared by"), h("dd", {}, people[doc.createdBy] || "—"),
    doc.issuedAt ? [h("dt", {}, "Issued"), h("dd", {}, fmtDate(doc.issuedAt))] : null,
    doc.issuedBy ? [h("dt", {}, "Approved by"), h("dd", {}, people[doc.issuedBy] || "—")] : null,
    doc.revokedAt ? [h("dt", {}, "Revoked"), h("dd", {}, `${fmtDate(doc.revokedAt)} — ${doc.revokeReason}`)] : null,
  ), relatedLinks.length ? h("div", { class: "stack", style: "margin-top:12px;font-size:.9rem" }, relatedLinks) : null)

  const verifyCard = verifyUrl
    ? h("div", { class: "card" }, h("h3", {}, "Verification"),
        h("p", { class: "muted", style: "font-size:.9rem" }, "Partners scan the QR code or open this link to confirm the document is genuine."),
        h("div", { class: "mono", style: "margin-bottom:10px" }, verifyUrl),
        h("div", { class: "row" },
          h("a", { class: "btn small", href: verifyUrl, target: "_blank", rel: "noopener" }, "Open verify page"),
          h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(verifyUrl).then(() => toast("Link copied")) }, "Copy link"),
        ),
        h("dl", { class: "kv", style: "margin-top:12px;font-size:.8rem" }, h("dt", {}, "Content hash"), h("dd", { class: "mono" }, doc.contentHash), h("dt", {}, "PDF hash"), h("dd", { class: "mono" }, doc.pdfHash)),
      )
    : null

  const timeline = h("div", { class: "card" }, h("h3", {}, "History"), h("ul", { class: "timeline" },
    history.filter((e) => e.action !== "document.verified").map((e) =>
      h("li", {}, h("time", {}, fmtDate(e.createdAt)), `${e.action.replace("document.", "").replace(/_/g, " ")} · ${e.userName || ""}`, e.details && e.details.note ? h("div", { class: "muted" }, `“${e.details.note}”`) : null),
    ),
  ), (() => {
    const scans = history.filter((e) => e.action === "document.verified").length
    return scans ? h("p", { class: "muted", style: "margin:10px 0 0;font-size:.85rem" }, `Checked by partners ${scans} time${scans === 1 ? "" : "s"}`) : null
  })())

  const notice =
    doc.status === "pending_approval" && state.org.requireSeparateApprover && mine
      ? h("div", { class: "notice info" }, "Waiting for an approver. Someone other than you must approve documents you prepare.")
      : doc.status === "draft" && doc.reviewNote
        ? h("div", { class: "notice warn" }, h("strong", {}, "Sent back: "), doc.reviewNote)
        : doc.status === "draft" && !editable
          ? h("div", { class: "notice info" }, "This draft belongs to someone else. Only they or an admin can edit it.")
          : null

  const main = editable
    ? h("div", { class: "stack" },
        h("div", { class: "card" }, h("label", { class: "field", style: "max-width:420px" }, h("span", {}, "Document number"), formApi.docNoInput)),
        h("div", { class: "card" }, formApi.el),
        h("div", { class: "card" }, h("div", { class: "row", style: "margin-bottom:10px" }, h("h3", { style: "margin:0" }, "Preview"), h("div", { class: "spacer" }),
          h("button", { class: "btn small", onclick: (e) => busy(e.currentTarget, async () => {
            await api("PATCH", `/api/documents/${id}`, { data: formApi.values(), documentNo: formApi.docNoInput.value.trim() })
            await loadPreview()
          }, err) }, "Save & refresh preview")), frameBox),
      )
    : frameBox

  shell("documents",
    pageHead(doc.documentNo, h("span", { class: "row" }, badge(doc.status), template.name), actions),
    err,
    notice,
    h("div", { class: "doc-layout", style: "margin-top:12px" }, main, h("aside", { class: "doc-side" }, details, verifyCard, timeline)),
  )
  loadPreview().catch((e) => toast(e.message, true))
}

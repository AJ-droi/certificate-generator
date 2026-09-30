// Templates: list, HTML template editor, and choosing how to add one.
import { busy, errorBox, fmtDate, h, readText, toast } from "../lib/dom.js"
import { api } from "./api.js"
import { pdfTemplateEditor } from "./pdf-editor.js"
import { previewFrame } from "./pdf-view.js"
import { go } from "../lib/router.js"
import { pageHead, shell } from "./shell.js"
import { isAdmin, loadTemplates, state } from "./state.js"

export async function templatesScreen() {
  shell("templates", h("p", { class: "loading" }, "Loading…"))
  const templates = await loadTemplates(true)
  const cards = templates.map((t) =>
    h("div", { class: "tile" },
      h("div", { class: "row" }, h("h3", {}, t.name), t.archived ? h("span", { class: "badge" }, "Archived") : null),
      h("p", { class: "muted", style: "margin:0;font-size:.9rem" }, t.description || "No description"),
      h("div", { class: "muted", style: "font-size:.8rem" }, `Version ${t.currentVersion ? t.currentVersion.version : "—"} · ${(t.currentVersion && t.currentVersion.schema.length) || 0} fields`),
      h("div", { class: "row", style: "margin-top:auto;padding-top:8px" },
        !t.archived ? h("a", { class: "btn small primary", href: `#/documents/new/${t.id}` }, "New document") : null,
        h("a", { class: "btn small", href: `#/templates/${t.id}` }, isAdmin() ? "Edit" : "View"),
      ),
    ),
  )
  shell("templates",
    pageHead("Templates", "Your document layouts and the fields each one needs.", isAdmin() ? h("a", { class: "btn primary", href: "#/templates/add" }, "Add template") : null),
    templates.length ? h("div", { class: "cards" }, cards) : h("div", { class: "card empty" }, "No templates yet."),
  )
}

export const STARTER_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: A4; margin: 0; }
body { font-family: Arial, sans-serif; margin: 0; }
.page { width: 210mm; min-height: 297mm; padding: 18mm; box-sizing: border-box; position: relative; }
.head { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #222; padding-bottom: 8px; }
.head img { height: 56px; }
.qr img { width: 90px; height: 90px; }
h1 { font-size: 22px; margin: 24px 0 8px; }
table { border-collapse: collapse; width: 100%; margin-top: 12px; }
td, th { border: 1px solid #333; padding: 6px; text-align: left; font-size: 12px; }
.sign { margin-top: 40px; display: flex; gap: 40px; }
.sign img { height: 48px; }
</style>
</head>
<body>
<div class="page">
<div class="head">
  {{#if org.logo}}<img src="{{org.logo}}" alt="">{{else}}<strong>{{org.name}}</strong>{{/if}}
  <div class="qr">{{#if qr}}<img src="{{qr}}" alt="QR"><div style="font:8px monospace">{{document.verificationCode}}</div>{{/if}}</div>
</div>
<h1>Certificate of Completion</h1>
<p>No. <strong>{{document.no}}</strong></p>
<p>This certifies that <strong>{{recipientName}}</strong> completed <strong>{{courseName}}</strong> on {{formatDate completedOn}}.</p>
<div class="sign">
  <div>{{#if preparedBy.signature}}<img src="{{preparedBy.signature}}" alt="">{{/if}}<div>{{preparedBy.name}}</div><small>Prepared by</small></div>
  <div>{{#if approvedBy}}{{#if approvedBy.signature}}<img src="{{approvedBy.signature}}" alt="">{{/if}}<div>{{approvedBy.name}}</div>{{else}}<div style="height:48px"></div><div>—</div>{{/if}}<small>Approved by</small></div>
</div>
</div>
</body>
</html>`

export const STARTER_SCHEMA = [
  { key: "recipientName", label: "Recipient name", type: "text", required: true, showOnVerify: true },
  { key: "courseName", label: "Course", type: "text", required: true, showOnVerify: true },
  { key: "completedOn", label: "Completed on", type: "date", required: true, showOnVerify: true },
]

export const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "checkbox", "image", "table"]
export const COLUMN_TYPES = ["text", "number", "date", "select", "checkbox"]

// Visual builder for the field list.
export function fieldBuilder(schema, onChange) {
  const wrap = h("div", { class: "stack" })
  const draw = () => {
    wrap.replaceChildren(
      ...schema.map((f, i) => fieldRow(f, i, schema, false)),
      h("button", { class: "btn small", type: "button", onclick: () => { schema.push({ key: `field${schema.length + 1}`, label: "New field", type: "text" }); draw(); onChange() } }, "+ Add field"),
    )
  }
  const fieldRow = (f, i, list, isColumn) => {
    const change = () => onChange()
    const types = isColumn ? COLUMN_TYPES : FIELD_TYPES
    const move = (d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; draw(); change() }
    const box = h("div", { class: "fieldset", style: isColumn ? "padding:10px;background:var(--surface-2)" : "" },
      h("div", { class: "grid-2" },
        h("label", { class: "field" }, h("span", {}, "Label"), h("input", { value: f.label, oninput: (e) => { f.label = e.target.value; change() } })),
        h("label", { class: "field" }, h("span", {}, "Key (used in the layout)"), h("input", { value: f.key, class: "mono", oninput: (e) => { f.key = e.target.value.trim(); change() } })),
        h("label", { class: "field" }, h("span", {}, "Type"), h("select", { onchange: (e) => {
          f.type = e.target.value
          if (f.type === "select" && !f.options) f.options = ["Option 1", "Option 2"]
          if (f.type === "table" && !f.columns) f.columns = [{ key: "description", label: "Description", type: "text" }]
          draw(); change()
        } }, types.map((t) => h("option", { value: t, selected: t === f.type ? true : null }, t)))),
        f.type === "select"
          ? h("label", { class: "field" }, h("span", {}, "Options (comma separated)"), h("input", { value: (f.options || []).join(", "), oninput: (e) => { f.options = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); change() } }))
          : h("div"),
        h("div", { class: "row full" },
          h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.required, onchange: (e) => { f.required = e.target.checked; change() } }), "Required"),
          !isColumn && !["table", "image"].includes(f.type) ? h("label", { class: "check" }, h("input", { type: "checkbox", checked: f.showOnVerify, onchange: (e) => { f.showOnVerify = e.target.checked; change() } }), "Show on verify page") : null,
          h("div", { class: "spacer" }),
          h("button", { class: "btn small ghost", type: "button", "aria-label": "Move up", onclick: () => move(-1) }, "↑"),
          h("button", { class: "btn small ghost", type: "button", "aria-label": "Move down", onclick: () => move(1) }, "↓"),
          h("button", { class: "btn small danger", type: "button", onclick: () => { list.splice(i, 1); draw(); change() } }, "Remove"),
        ),
      ),
      f.type === "table"
        ? h("div", { class: "stack", style: "margin-top:12px" }, h("strong", {}, "Columns"),
            f.columns.map((c, j) => fieldRow(c, j, f.columns, true)),
            h("button", { class: "btn small", type: "button", onclick: () => { f.columns.push({ key: `col${f.columns.length + 1}`, label: "Column", type: "text" }); draw(); change() } }, "+ Add column"))
        : null,
    )
    return box
  }
  draw()
  return wrap
}

export async function templateEditorScreen(id) {
  shell("templates", h("p", { class: "loading" }, "Loading…"))
  const isNew = id === "new"
  let template = null
  let version = null
  let history = []
  if (!isNew) ({ template, version, history } = await api("GET", `/api/templates/${id}`))
  if (version && version.kind === "pdf") return pdfTemplateEditor(id, { template, version, history })
  const readOnly = !isAdmin()

  const model = {
    name: template ? template.name : "",
    description: template ? template.description : "",
    html: version ? version.html : STARTER_HTML,
    schema: JSON.parse(JSON.stringify(version ? version.schema : STARTER_SCHEMA)),
    settings: version ? { ...version.settings } : { numberPrefix: "CERT-", numberPadding: 4, sampleData: { recipientName: "Jane Doe", courseName: "Working at Height", completedOn: "2026-01-21" } },
  }

  const err = h("div")
  const { box: frameBox, show: showPreview } = previewFrame("Template preview")
  const previewMsg = h("div")
  let dirty = false
  const markDirty = () => { dirty = true }

  const refreshPreview = async () => {
    previewMsg.replaceChildren()
    try {
      await showPreview(await api("POST", "/api/templates/preview", { html: model.html, schema: model.schema, data: model.settings.sampleData || {} }))
    } catch (e) {
      previewMsg.replaceChildren(errorBox(e))
    }
  }

  // Tabs
  const htmlArea = h("textarea", { class: "code", spellcheck: "false", value: model.html, readonly: readOnly || null, oninput: (e) => { model.html = e.target.value; markDirty() } })
  htmlArea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault()
      const s = htmlArea.selectionStart
      htmlArea.setRangeText("  ", s, htmlArea.selectionEnd, "end")
      model.html = htmlArea.value
    }
  })
  const upload = h("label", { class: "btn small" }, "Upload .html / .hbs file", h("input", { type: "file", accept: ".html,.htm,.hbs,text/html", style: "display:none", onchange: async (e) => {
    const f = e.target.files[0]
    if (!f) return
    model.html = await readText(f)
    htmlArea.value = model.html
    markDirty()
    toast(`Loaded ${f.name}`)
    refreshPreview()
  } }))

  const helpers = h("details", { class: "helper-ref card", style: "margin-top:10px" },
    h("summary", {}, "What can I use in the layout?"),
    h("div", { style: "margin-top:8px" },
      h("p", {}, "Layouts are HTML with ", h("a", { href: "https://handlebarsjs.com/guide/", target: "_blank", rel: "noopener" }, "Handlebars"), " placeholders. Each field's key becomes a placeholder, e.g. ", h("code", {}, "{{recipientName}}"), "."),
      h("ul", {},
        h("li", {}, h("code", {}, "{{document.no}}"), " number · ", h("code", {}, "{{document.verificationCode}}"), " code under the QR"),
        h("li", {}, h("code", {}, "<img src=\"{{qr}}\">"), " QR code (empty in drafts) · ", h("code", {}, "{{verifyUrl}}")),
        h("li", {}, h("code", {}, "{{org.name}}"), ", ", h("code", {}, "{{org.logo}}"), " your company"),
        h("li", {}, h("code", {}, "{{preparedBy.name}}"), " / ", h("code", {}, ".qualification"), " / ", h("code", {}, ".signature"), " — the person who prepared it"),
        h("li", {}, h("code", {}, "{{#if approvedBy}}…{{approvedBy.signature}}…{{/if}}"), " — the approver, only once issued"),
        h("li", {}, h("code", {}, "{{#each (chunk items 10)}}…{{/each}}"), " split a table into pages of 10 rows"),
        h("li", {}, "Helpers: ", ["formatDate", "check", "yesno", "upper", "default", "inc", "add", "mul", "length", "eq", "ne", "and", "or", "not"].map((x, i) => [i ? ", " : "", h("code", {}, x)])),
      ),
      h("p", { class: "muted" }, "Use inline CSS. External files can only load from a few public CDNs (Google Fonts, jsDelivr, cdnjs) — anything else is blocked when the PDF is made."),
    ),
  )

  const schemaJson = h("textarea", { class: "code", spellcheck: "false", style: "min-height:360px" })
  const builderHost = h("div")
  const drawBuilder = () => builderHost.replaceChildren(fieldBuilder(model.schema, () => { markDirty(); schemaJson.value = JSON.stringify(model.schema, null, 2) }))
  schemaJson.value = JSON.stringify(model.schema, null, 2)
  schemaJson.addEventListener("change", () => {
    try {
      model.schema = JSON.parse(schemaJson.value)
      drawBuilder()
      markDirty()
    } catch (e) {
      toast(`Fields JSON: ${e.message}`, true)
    }
  })
  drawBuilder()
  const fieldsPane = h("div", {}, builderHost, h("details", { style: "margin-top:12px" }, h("summary", {}, "Edit as JSON"), schemaJson))

  const sampleArea = h("textarea", { class: "code", spellcheck: "false", style: "min-height:360px" })
  sampleArea.value = JSON.stringify(model.settings.sampleData || {}, null, 2)
  sampleArea.addEventListener("change", () => {
    try {
      model.settings.sampleData = JSON.parse(sampleArea.value || "{}")
      markDirty()
    } catch (e) {
      toast(`Sample data: ${e.message}`, true)
    }
  })
  const samplePane = h("div", {}, h("p", { class: "muted" }, "Example values used for the preview, and for “Fill with sample data” on new documents."), sampleArea)

  const settingsPane = h("div", { class: "stack" },
    h("label", { class: "field" }, h("span", {}, "Name"), h("input", { value: model.name, readonly: readOnly || null, oninput: (e) => { model.name = e.target.value; markDirty() } })),
    h("label", { class: "field" }, h("span", {}, "Description"), h("textarea", { rows: 2, value: model.description, readonly: readOnly || null, oninput: (e) => { model.description = e.target.value; markDirty() } })),
    h("div", { class: "grid-2" },
      h("label", { class: "field" }, h("span", {}, "Number prefix"), h("input", { value: model.settings.numberPrefix || "", oninput: (e) => { model.settings.numberPrefix = e.target.value; markDirty() } }), h("small", {}, "e.g. ELS/MTC-HB-")),
      h("label", { class: "field" }, h("span", {}, "Digits"), h("input", { type: "number", min: 1, max: 8, value: model.settings.numberPadding || 4, oninput: (e) => { model.settings.numberPadding = Number(e.target.value); markDirty() } }), h("small", {}, "4 → 0001, 0002…")),
    ),
    !isNew && isAdmin()
      ? h("div", { class: "row" }, h("button", { class: "btn", onclick: (e) => busy(e.currentTarget, async () => {
          await api("PATCH", `/api/templates/${id}`, { archived: !template.archived })
          toast(template.archived ? "Restored" : "Archived")
          go(`#/templates/${id}`, true)
        }) }, template && template.archived ? "Restore template" : "Archive template"), h("span", { class: "muted", style: "font-size:.85rem" }, "Archived templates can't be used for new documents. Existing documents aren't affected."))
      : null,
    history.length ? h("div", {}, h("h3", {}, "Versions"), h("ul", { class: "timeline" }, history.map((v) => h("li", {}, h("time", {}, fmtDate(v.createdAt)), `Version ${v.version}`, v.id === template.currentVersionId ? " (current)" : "")))) : null,
  )

  const lock = (node) => (readOnly ? h("fieldset", { disabled: true, style: "border:0;padding:0;margin:0;min-width:0" }, node) : node)
  const panes = { Layout: h("div", {}, h("div", { class: "row", style: "margin-bottom:8px" }, readOnly ? null : upload), htmlArea, helpers), Fields: lock(fieldsPane), "Sample data": lock(samplePane), Settings: lock(settingsPane) }
  const paneHost = h("div")
  const tabBar = h("div", { class: "editor-tabs", role: "tablist" })
  const showTab = (name) => {
    tabBar.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.textContent === name))
    paneHost.replaceChildren(panes[name])
  }
  Object.keys(panes).forEach((name) => tabBar.append(h("button", { type: "button", role: "tab", onclick: () => showTab(name) }, name)))

  const save = h("button", { class: "btn primary", onclick: () => busy(save, async () => {
    if (isNew) {
      const r = await api("POST", "/api/templates", model)
      dirty = false
      toast("Template created")
      state.templates = null
      go(`#/templates/${r.template.id}`)
    } else {
      if (model.name !== template.name || model.description !== template.description) {
        await api("PATCH", `/api/templates/${id}`, { name: model.name, description: model.description })
      }
      const r = await api("POST", `/api/templates/${id}/versions`, { html: model.html, schema: model.schema, settings: model.settings })
      dirty = false
      state.templates = null
      toast(r.unchanged ? "Saved (no layout changes)" : `Saved as version ${r.version.version}`)
      go(`#/templates/${id}`, true)
    }
  }, err) }, isNew ? "Create template" : "Save new version")

  window.onbeforeunload = () => (dirty ? true : undefined)

  shell("templates",
    pageHead(isNew ? "Add template" : model.name, isNew ? "Start from the example, paste your own layout, or upload a file." : `Version ${version.version}. Saving creates a new version — documents already made keep theirs.`,
      !isNew ? h("a", { class: "btn", href: `#/documents/new/${id}` }, "New document") : null, readOnly ? null : save),
    err,
    h("div", { class: "editor-layout" },
      h("div", {}, tabBar, paneHost),
      h("div", {}, h("div", { class: "row", style: "margin-bottom:8px" }, h("h3", { style: "margin:0" }, "Preview"), h("span", { class: "muted", style: "font-size:.85rem" }, "with sample data"), h("div", { class: "spacer" }),
        h("button", { class: "btn small", onclick: (e) => busy(e.currentTarget, refreshPreview) }, "Refresh preview")), previewMsg, frameBox),
    ),
  )
  showTab(isNew ? "Layout" : "Layout")
  refreshPreview()
}

export function templateChooserScreen() {
  if (!isAdmin()) return go("#/templates")
  shell("templates",
    pageHead("Add a template", "How would you like to create it?"),
    h("div", { class: "cards chooser" },
      h("a", { class: "tile choice", href: "#/templates/new-pdf" },
        h("span", { class: "badge issued", style: "align-self:flex-start" }, "Recommended"),
        h("h3", {}, "Upload your PDF form"),
        h("p", { class: "muted" }, "Use the form you already have. Draw boxes where the information goes — your design stays exactly the same."),
        h("span", { class: "btn primary", style: "margin-top:auto;align-self:flex-start" }, "Upload PDF")),
      h("a", { class: "tile choice", href: "#/templates/new" },
        h("h3", {}, "Design with HTML"),
        h("p", { class: "muted" }, "For developers: write the layout as HTML with placeholders. Best for documents with long, variable tables."),
        h("span", { class: "btn", style: "margin-top:auto;align-self:flex-start" }, "Start from an example")),
    ),
  )
}

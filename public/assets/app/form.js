// The document form built from a template's field schema (including tables).
import { h, modal, readImage, toast } from "../lib/dom.js"

export function buildForm(schema, data) {
  const values = JSON.parse(JSON.stringify(data || {}))
  const container = h("div", { class: "stack" })
  const simple = h("div", { class: "grid-2" })
  container.append(simple)

  for (const field of schema) {
    if (field.type === "table") {
      container.append(tableEditor(field, values))
      continue
    }
    simple.append(fieldControl(field, values))
  }
  return { el: container, values: () => values }
}

export function label(field) {
  return h("span", {}, field.label, field.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null)
}

export function fieldControl(field, values) {
  const set = (v) => { values[field.key] = v }
  const v = values[field.key]
  const help = field.help ? h("small", {}, field.help) : null
  switch (field.type) {
    case "textarea":
      return h("label", { class: "field full" }, label(field), h("textarea", { rows: 3, value: v || "", oninput: (e) => set(e.target.value) }), help)
    case "checkbox":
      return h("label", { class: "check" }, h("input", { type: "checkbox", checked: v, onchange: (e) => set(e.target.checked) }), field.label)
    case "select":
      return h("label", { class: "field" }, label(field), h("select", { onchange: (e) => set(e.target.value) },
        h("option", { value: "" }, "—"), field.options.map((o) => h("option", { value: o, selected: o === v ? true : null }, o))), help)
    case "image": {
      const preview = h("div", { class: "img-field" })
      const draw = () => preview.replaceChildren(
        values[field.key] ? h("img", { src: values[field.key], alt: "" }) : h("span", { class: "muted" }, "No image"),
        h("label", { class: "btn small" }, "Choose image", h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", style: "display:none", onchange: async (e) => {
          try { set(await readImage(e.target.files[0])); draw() } catch (err) { toast(err.message, true) }
        } })),
        values[field.key] ? h("button", { class: "btn small ghost", type: "button", onclick: () => { set(""); draw() } }, "Remove") : null,
      )
      draw()
      return h("div", { class: "field full" }, h("label", { class: "field" }, label(field)), preview, help)
    }
    default:
      return h("label", { class: "field" }, label(field),
        h("input", { type: field.type === "number" ? "number" : field.type === "date" ? "date" : "text", step: field.type === "number" ? "any" : null, value: v ?? "", oninput: (e) => set(e.target.value) }), help)
  }
}

export function tableEditor(field, values) {
  if (!Array.isArray(values[field.key])) values[field.key] = []
  const rows = values[field.key]
  const tbody = h("tbody")
  const count = h("span", { class: "muted" })

  const cell = (col, row) => {
    const set = (v) => { row[col.key] = v }
    if (col.type === "checkbox") return h("input", { type: "checkbox", checked: row[col.key], onchange: (e) => set(e.target.checked), "aria-label": col.label })
    if (col.type === "select") {
      return h("select", { onchange: (e) => set(e.target.value), "aria-label": col.label },
        h("option", { value: "" }, "—"), col.options.map((o) => h("option", { value: o, selected: o === row[col.key] ? true : null }, o)))
    }
    return h("input", { type: col.type === "number" ? "number" : col.type === "date" ? "date" : "text", value: row[col.key] ?? "", oninput: (e) => set(e.target.value), "aria-label": col.label })
  }

  const draw = () => {
    if (!rows.length) {
      tbody.replaceChildren(h("tr", {}, h("td", { colspan: field.columns.length + 2, class: "muted", style: "padding:14px;text-align:center" }, "No rows yet — add one or paste from a spreadsheet.")))
      count.textContent = "0 rows"
      return
    }
    tbody.replaceChildren(...rows.map((row, i) =>
      h("tr", {},
        h("td", { class: "n" }, i + 1),
        field.columns.map((col) => h("td", {}, cell(col, row))),
        h("td", { class: "x" }, h("button", { class: "btn small ghost", type: "button", title: "Remove row", "aria-label": `Remove row ${i + 1}`, onclick: () => { rows.splice(i, 1); draw() } }, "✕")),
      ),
    ))
    count.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`
  }
  draw()

  const addRow = () => {
    const row = {}
    for (const c of field.columns) row[c.key] = c.type === "checkbox" ? false : ""
    rows.push(row)
    draw()
    const inputs = tbody.lastElementChild && tbody.lastElementChild.querySelector("input,select")
    if (inputs) inputs.focus()
  }

  const paste = async () => {
    const res = await modal(`Paste rows into ${field.label}`, [
      h("p", { class: "muted" }, `Copy rows from Excel or Google Sheets and paste them below. Columns must be in this order: ${field.columns.map((c) => c.label).join(" · ")}`),
      h("textarea", { name: "tsv", rows: 8, class: "code", style: "min-height:160px", placeholder: "Paste here" }),
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "replace" }), "Replace existing rows"),
    ], { submitLabel: "Add rows" })
    if (!res || !res.tsv.trim()) return
    const lines = res.tsv.replace(/\r/g, "").split("\n").filter((l) => l.trim())
    if (res.replace) rows.splice(0, rows.length)
    for (const line of lines) {
      const cells = line.split("\t")
      const row = {}
      field.columns.forEach((c, i) => {
        const val = (cells[i] || "").trim()
        row[c.key] = c.type === "checkbox" ? /^(yes|y|true|1|x|✓)$/i.test(val) : val
      })
      rows.push(row)
    }
    draw()
    toast(`${lines.length} row(s) added`)
  }

  return h("fieldset", { class: "fieldset" },
    h("legend", {}, field.label, field.required ? h("span", { class: "req" }, " *") : null),
    h("div", { class: "table-editor" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "#"), field.columns.map((c) => h("th", {}, c.label, c.required ? h("span", { class: "req" }, " *") : null)), h("th"))),
      tbody,
    )),
    h("div", { class: "row", style: "margin-top:10px" },
      h("button", { class: "btn small", type: "button", onclick: addRow }, "+ Add row"),
      h("button", { class: "btn small", type: "button", onclick: paste }, "Paste from spreadsheet"),
      h("div", { class: "spacer" }), count,
    ),
  )
}

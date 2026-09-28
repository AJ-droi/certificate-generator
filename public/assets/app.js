/* Company dashboard. Plain JS, no build step. */
;(function () {
  "use strict"

  // ---------------------------------------------------------------- helpers
  const root = document.getElementById("root")
  const state = { me: null, org: null, config: { appName: "DocTrust", allowSignup: true }, templates: null }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue
      if (k === "class") el.className = v
      else if (k === "style") el.style.cssText = v
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
      else if (k === "value") el.value = v
      else if (k === "checked") el.checked = Boolean(v)
      else if (k === "html") el.innerHTML = v // only used with static strings
      else el.setAttribute(k, v === true ? "" : v)
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue
      el.append(c instanceof Node ? c : document.createTextNode(String(c)))
    }
    return el
  }

  function toast(message, bad) {
    const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: "status" }, message)
    document.getElementById("toasts").append(t)
    setTimeout(() => t.remove(), bad ? 6000 : 3000)
  }

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.message) || `Request failed (${status})`)
      this.status = status
      this.body = body || {}
    }
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith("/api/auth/")) {
        state.me = null
        go("#/login")
      }
      if (res.status === 403 && data && data.details && data.details.code === "must_change_password") {
        go("#/change-password")
      }
      throw new ApiError(res.status, data)
    }
    return data
  }

  function errorBox(err) {
    const details = err && err.body && err.body.details && err.body.details.errors
    return h("div", { class: "error-box", role: "alert" }, err.message, details ? h("ul", {}, details.map((d) => h("li", {}, d))) : null)
  }

  // Wraps an async action on a button: disables it and shows errors.
  async function busy(button, fn, errorHost) {
    const label = button ? button.textContent : ""
    if (button) {
      button.disabled = true
      button.textContent = "Working…"
    }
    if (errorHost) errorHost.replaceChildren()
    try {
      return await fn()
    } catch (err) {
      if (errorHost) errorHost.replaceChildren(errorBox(err))
      else toast(err.message, true)
      return undefined
    } finally {
      if (button) {
        button.disabled = false
        button.textContent = label
      }
    }
  }

  const fmtDate = (d) =>
    d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""
  const STATUS_LABEL = {
    draft: "Draft",
    pending_approval: "Awaiting approval",
    issued: "Issued",
    revoked: "Revoked",
    superseded: "Superseded",
  }
  const badge = (status) => h("span", { class: `badge ${status}` }, STATUS_LABEL[status] || status)
  const isAdmin = () => state.me && state.me.role === "admin"
  const canApprove = () => state.me && ["admin", "approver"].includes(state.me.role)

  function readImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error("Use a PNG, JPEG, WebP or GIF image"))
      if (file.size > 500 * 1024) return reject(new Error("Image must be under 500 KB"))
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(new Error("Couldn't read that file"))
      r.readAsDataURL(file)
    })
  }

  function readText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(new Error("Couldn't read that file"))
      r.readAsText(file)
    })
  }

  function modal(title, bodyNodes, { submitLabel = "OK", danger = false, cancel = true } = {}) {
    return new Promise((resolve) => {
      const err = h("div")
      const dlg = h("dialog")
      const form = h(
        "form",
        { method: "dialog" },
        h("h2", {}, title),
        bodyNodes,
        err,
        h(
          "div",
          { class: "row", style: "justify-content:flex-end" },
          cancel ? h("button", { class: "btn", type: "button", onclick: () => { dlg.close(); resolve(null) } }, "Cancel") : null,
          h("button", { class: `btn ${danger ? "danger" : "primary"}`, type: "submit" }, submitLabel),
        ),
      )
      form.addEventListener("submit", (e) => {
        e.preventDefault()
        const data = Object.fromEntries(new FormData(form).entries())
        dlg.close()
        resolve(data)
      })
      dlg.addEventListener("cancel", () => resolve(null))
      dlg.addEventListener("close", () => setTimeout(() => dlg.remove(), 0))
      dlg.append(form)
      document.body.append(dlg)
      dlg.showModal()
    })
  }

  function showSecret(title, text, secret) {
    return modal(title, [h("p", {}, text), h("div", { class: "secret" }, secret)], { submitLabel: "Done", cancel: false })
  }

  // An A4 page is ~794px wide. Render the iframe at page width and scale it to fit.
  const PAGE_PX = 830
  function previewFrame(title) {
    const frame = h("iframe", { title, sandbox: "allow-scripts allow-popups", referrerpolicy: "no-referrer" })
    const box = h("div", { class: "preview-box" }, frame)
    const fit = () => {
      const s = Math.min(1, box.clientWidth / PAGE_PX) || 1
      frame.style.transform = `scale(${s})`
      frame.style.width = `${PAGE_PX}px`
      frame.style.height = `${box.clientHeight / s}px`
    }
    new ResizeObserver(fit).observe(box)
    return { box, frame }
  }

  // ---------------------------------------------------------------- icons
  const ICON = {
    docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
    tmpl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a5 5 0 0 1 3.5 6"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/></svg>',
    menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
    shield: '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor" opacity=".15"/><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  }
  const icon = (name) => h("span", { html: ICON[name], style: "display:inline-flex" })
  const brand = () => h("a", { class: "brand", href: "/" }, icon("shield"), h("span", {}, state.config.appName))

  // ---------------------------------------------------------------- shell
  function shell(active, ...content) {
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
    app.append(sidebar, h("div", {}, bar, h("main", { class: "content" }, content)))
    root.replaceChildren(app)
  }

  function pageHead(title, sub, ...actions) {
    return h("div", { class: "page-head" }, h("div", {}, h("h1", {}, title), sub ? h("div", { class: "sub" }, sub) : null), h("div", { class: "spacer" }), actions)
  }

  async function logout() {
    await api("POST", "/api/auth/logout", {}).catch(() => {})
    state.me = null
    go("#/login")
  }

  // ---------------------------------------------------------------- auth screens
  function authScreen(title, sub, fields, submitLabel, onSubmit, footer) {
    const err = h("div")
    const btn = h("button", { class: "btn primary", type: "submit" }, submitLabel)
    const form = h("form", {}, fields, err, btn)
    form.addEventListener("submit", (e) => {
      e.preventDefault()
      busy(btn, () => onSubmit(Object.fromEntries(new FormData(form).entries())), err)
    })
    root.replaceChildren(
      h("div", { class: "auth-wrap" }, h("div", { class: "card auth-card" }, brand(), h("h1", {}, title), sub ? h("p", { class: "muted" }, sub) : null, form, footer)),
    )
    const first = form.querySelector("input")
    if (first) first.focus()
  }

  const input = (name, label, attrs = {}, help) =>
    h("label", { class: "field" }, h("span", {}, label), h("input", { name, ...attrs }), help ? h("small", {}, help) : null)

  function loginScreen() {
    authScreen(
      "Sign in",
      "Sign in to issue and manage your company's documents.",
      [input("email", "Email", { type: "email", autocomplete: "username", required: true }), input("password", "Password", { type: "password", autocomplete: "current-password", required: true })],
      "Sign in",
      async (data) => {
        await api("POST", "/api/auth/login", data)
        await loadMe()
        go(state.me.mustChangePassword ? "#/change-password" : "#/documents")
      },
      state.config.allowSignup ? h("p", { class: "muted", style: "margin-top:16px" }, "New company? ", h("a", { href: "#/signup" }, "Create an account")) : null,
    )
  }

  function signupScreen() {
    authScreen(
      "Create your company account",
      "You'll be the admin. You can invite your team afterwards.",
      [
        input("orgName", "Company name", { required: true, autocomplete: "organization" }),
        input("name", "Your name", { required: true, autocomplete: "name" }),
        input("email", "Work email", { type: "email", required: true, autocomplete: "username" }),
        input("password", "Password", { type: "password", required: true, minlength: 10, autocomplete: "new-password" }, "At least 10 characters"),
      ],
      "Create account",
      async (data) => {
        await api("POST", "/api/auth/signup", data)
        await loadMe()
        go("#/templates")
        toast("Account created. Start by adding a template.")
      },
      h("p", { class: "muted", style: "margin-top:16px" }, "Already have an account? ", h("a", { href: "#/login" }, "Sign in")),
    )
  }

  function changePasswordScreen() {
    authScreen(
      "Set a new password",
      state.me && state.me.mustChangePassword ? "You signed in with a temporary password. Choose your own to continue." : null,
      [
        input("currentPassword", "Current (temporary) password", { type: "password", required: true, autocomplete: "current-password" }),
        input("newPassword", "New password", { type: "password", required: true, minlength: 10, autocomplete: "new-password" }, "At least 10 characters"),
      ],
      "Save password",
      async (data) => {
        await api("POST", "/api/auth/password", data)
        await loadMe()
        toast("Password updated")
        go("#/documents")
      },
    )
  }

  // ---------------------------------------------------------------- templates cache
  async function loadTemplates(force) {
    if (!state.templates || force) state.templates = (await api("GET", "/api/templates")).templates
    return state.templates
  }

  // ---------------------------------------------------------------- documents list
  async function documentsScreen(params) {
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
      body = h("div", { class: "card empty" }, h("h2", {}, "Add your first template"), h("p", {}, "Templates are your certificate and report layouts. Add one, then you can start issuing documents."), isAdmin() ? h("a", { class: "btn primary", href: "#/templates/new" }, "Add a template") : h("p", {}, "Ask an admin to add one."))
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

  // ---------------------------------------------------------------- schema-driven form
  function buildForm(schema, data) {
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

  function label(field) {
    return h("span", {}, field.label, field.required ? h("span", { class: "req", "aria-hidden": "true" }, " *") : null)
  }

  function fieldControl(field, values) {
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

  function tableEditor(field, values) {
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

  // ---------------------------------------------------------------- new document
  async function newDocumentScreen(templateId) {
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
    const sampleBtn = version.settings.sampleData && Object.keys(version.settings.sampleData).length
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

  // ---------------------------------------------------------------- document screen
  async function documentScreen(id) {
    shell("documents", h("p", { class: "loading" }, "Loading…"))
    const res = await api("GET", `/api/documents/${id}`)
    const { document: doc, template, version, related, people, history, verifyUrl } = res
    const mine = doc.createdBy === state.me.id
    const editable = doc.status === "draft" && (mine || isAdmin())
    const err = h("div")
    const { box: frameBox, frame } = previewFrame("Document preview")
    const loadPreview = async () => {
      const r = await api("GET", `/api/documents/${id}/render`)
      frame.src = r.previewUrl
    }

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
        actions.push(act("Approve & issue", "approve", {
          cls: "primary",
          done: "Issued",
          confirm: { title: "Issue this document?", body: [h("p", {}, "It will be signed, locked and given a QR code. After this, changes need a correction.")], submit: "Issue" },
        }))
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
      }
      actions.push(approve)
    }
    if (doc.status === "issued") {
      actions.push(h("a", { class: "btn", href: `/api/documents/${id}/pdf` }, "Download PDF"))
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
      actions.push(h("a", { class: "btn", href: `/api/documents/${id}/pdf` }, "Download PDF"))
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

  // ---------------------------------------------------------------- templates
  async function templatesScreen() {
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
      pageHead("Templates", "Your document layouts and the fields each one needs.", isAdmin() ? h("a", { class: "btn primary", href: "#/templates/new" }, "Add template") : null),
      templates.length ? h("div", { class: "cards" }, cards) : h("div", { class: "card empty" }, "No templates yet."),
    )
  }

  const STARTER_HTML = `<!doctype html>
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

  const STARTER_SCHEMA = [
    { key: "recipientName", label: "Recipient name", type: "text", required: true, showOnVerify: true },
    { key: "courseName", label: "Course", type: "text", required: true, showOnVerify: true },
    { key: "completedOn", label: "Completed on", type: "date", required: true, showOnVerify: true },
  ]

  const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "checkbox", "image", "table"]
  const COLUMN_TYPES = ["text", "number", "date", "select", "checkbox"]

  // Visual builder for the field list.
  function fieldBuilder(schema, onChange) {
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

  async function templateEditorScreen(id) {
    shell("templates", h("p", { class: "loading" }, "Loading…"))
    const isNew = id === "new"
    let template = null
    let version = null
    let history = []
    if (!isNew) ({ template, version, history } = await api("GET", `/api/templates/${id}`))
    const readOnly = !isAdmin()

    const model = {
      name: template ? template.name : "",
      description: template ? template.description : "",
      html: version ? version.html : STARTER_HTML,
      schema: JSON.parse(JSON.stringify(version ? version.schema : STARTER_SCHEMA)),
      settings: version ? { ...version.settings } : { numberPrefix: "CERT-", numberPadding: 4, sampleData: { recipientName: "Jane Doe", courseName: "Working at Height", completedOn: "2026-01-21" } },
    }

    const err = h("div")
    const { box: frameBox, frame } = previewFrame("Template preview")
    const previewMsg = h("div")
    let dirty = false
    const markDirty = () => { dirty = true }

    const refreshPreview = async () => {
      previewMsg.replaceChildren()
      try {
        const r = await api("POST", "/api/templates/preview", { html: model.html, schema: model.schema, data: model.settings.sampleData || {} })
        frame.src = r.previewUrl
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

  // ---------------------------------------------------------------- people
  async function usersScreen() {
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

  // ---------------------------------------------------------------- settings
  async function settingsScreen() {
    await loadMe()
    const me = { ...state.me }
    const org = { ...state.org }
    const profileErr = h("div")
    const orgErr = h("div")

    const imagePicker = (current, onPick, label) => {
      const host = h("div", { class: "img-field" })
      let value = current
      const draw = () => host.replaceChildren(
        value ? h("img", { src: value, alt: "" }) : h("span", { class: "muted" }, "None"),
        h("label", { class: "btn small" }, `Upload ${label}`, h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", style: "display:none", onchange: async (e) => {
          try { value = await readImage(e.target.files[0]); onPick(value); draw() } catch (er) { toast(er.message, true) }
        } })),
        value ? h("button", { class: "btn small ghost", type: "button", onclick: () => { value = null; onPick(null); draw() } }, "Remove") : null,
      )
      draw()
      return host
    }

    const profile = { name: me.name, qualification: me.qualification, signature: me.signature }
    const saveProfile = h("button", { class: "btn primary", onclick: () => busy(saveProfile, async () => {
      await api("PATCH", "/api/me", profile)
      await loadMe()
      toast("Profile saved")
    }, profileErr) }, "Save profile")

    const orgModel = { name: org.name, logo: org.logo, requireSeparateApprover: org.requireSeparateApprover }
    const saveOrg = h("button", { class: "btn primary", onclick: () => busy(saveOrg, async () => {
      await api("PATCH", "/api/org", orgModel)
      await loadMe()
      toast("Company settings saved")
    }, orgErr) }, "Save company settings")

    shell("settings",
      pageHead("Settings"),
      h("div", { class: "stack", style: "max-width:760px" },
        h("section", { class: "card stack" },
          h("h2", {}, "Your profile"),
          h("p", { class: "muted" }, "Your name, qualification and signature appear on documents you prepare or approve."),
          h("div", { class: "grid-2" },
            h("label", { class: "field" }, h("span", {}, "Name"), h("input", { value: profile.name, oninput: (e) => { profile.name = e.target.value } })),
            h("label", { class: "field" }, h("span", {}, "Qualification"), h("input", { value: profile.qualification || "", placeholder: "e.g. ASNT Level II, LEEA Diploma", oninput: (e) => { profile.qualification = e.target.value } })),
          ),
          h("div", { class: "field" }, h("label", { class: "field" }, h("span", {}, "Signature")), imagePicker(profile.signature, (v) => { profile.signature = v }, "signature"),
            h("small", { class: "muted" }, "A PNG with a transparent background looks best.")),
          profileErr,
          h("div", { class: "row" }, saveProfile, h("a", { class: "btn", href: "#/change-password" }, "Change password")),
        ),
        isAdmin()
          ? h("section", { class: "card stack" },
              h("h2", {}, "Company"),
              h("label", { class: "field" }, h("span", {}, "Company name"), h("input", { value: orgModel.name, oninput: (e) => { orgModel.name = e.target.value } }), h("small", {}, "Shown to partners on the verify page.")),
              h("div", { class: "field" }, h("label", { class: "field" }, h("span", {}, "Logo")), imagePicker(orgModel.logo, (v) => { orgModel.logo = v }, "logo")),
              h("label", { class: "check" }, h("input", { type: "checkbox", checked: orgModel.requireSeparateApprover, onchange: (e) => { orgModel.requireSeparateApprover = e.target.checked } }),
                "Require a second person to approve (recommended)"),
              h("small", { class: "muted" }, "When on, nobody can approve a document they prepared themselves."),
              orgErr,
              h("div", { class: "row" }, saveOrg),
            )
          : null,
        h("section", { class: "card" },
          h("h2", {}, "Signing key"),
          h("p", { class: "muted" }, "Every document you issue is signed with your company's private key, which never leaves the server. Partners can check signatures with this public key."),
          h("dl", { class: "kv" }, h("dt", {}, "Company ID"), h("dd", { class: "mono" }, org.slug), h("dt", {}, "Key ID"), h("dd", { class: "mono" }, org.keyId), h("dt", {}, "Algorithm"), h("dd", {}, "Ed25519")),
          h("pre", { class: "mono", style: "white-space:pre-wrap;background:var(--surface-2);padding:10px;border-radius:8px;margin-top:10px" }, org.publicKey),
        ),
      ),
    )
  }

  // ---------------------------------------------------------------- audit
  async function auditScreen() {
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

  // ---------------------------------------------------------------- router
  function go(hash, force) {
    if (location.hash === hash && force) route()
    else location.hash = hash
  }

  async function loadMe() {
    try {
      const r = await api("GET", "/api/auth/me")
      state.me = r.user
      state.org = r.organization
    } catch {
      state.me = null
      state.org = null
    }
  }

  async function route() {
    window.onbeforeunload = null
    const [path, query] = (location.hash.slice(1) || "/documents").split("?")
    const params = new URLSearchParams(query || "")
    const parts = path.split("/").filter(Boolean)
    const publicRoutes = ["login", "signup"]

    if (!state.me && !publicRoutes.includes(parts[0])) return loginScreen()
    if (state.me && publicRoutes.includes(parts[0])) return go("#/documents")
    if (state.me && state.me.mustChangePassword && parts[0] !== "change-password") return go("#/change-password")

    try {
      switch (parts[0]) {
        case "login": return loginScreen()
        case "signup": return state.config.allowSignup ? signupScreen() : loginScreen()
        case "change-password": return changePasswordScreen()
        case "documents":
          if (parts[1] === "new" && parts[2]) return await newDocumentScreen(parts[2])
          if (parts[1]) return await documentScreen(parts[1])
          return await documentsScreen(params)
        case "templates":
          if (parts[1]) return await templateEditorScreen(parts[1])
          return await templatesScreen()
        case "users": return await usersScreen()
        case "settings": return await settingsScreen()
        case "audit": return await auditScreen()
        default: return go("#/documents")
      }
    } catch (err) {
      if (err.status === 401) return
      shell(parts[0], h("div", { class: "card" }, errorBox(err), h("p", { style: "margin-top:12px" }, h("a", { class: "btn", href: "#/documents" }, "Back to documents"))))
    }
  }

  async function boot() {
    try {
      state.config = await (await fetch("/api/public/config")).json()
    } catch {}
    document.title = `${state.config.appName} — Dashboard`
    await loadMe()
    window.addEventListener("hashchange", route)
    route()
  }

  boot()
})()

// DOM helpers shared by the company dashboard and the staff dashboard.

export const root = document.getElementById("root")

// h("div", { class: "x", onclick }, ...children) — a tiny element builder.
export function h(tag, attrs, ...children) {
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

export function toast(message, bad) {
  const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: "status" }, message)
  document.getElementById("toasts").append(t)
  setTimeout(() => t.remove(), bad ? 6000 : 3000)
}

export function errorBox(err) {
  const details = err && err.body && err.body.details && err.body.details.errors
  return h("div", { class: "error-box", role: "alert" }, err.message, details ? h("ul", {}, details.map((d) => h("li", {}, d))) : null)
}

// Wraps an async action on a button: disables it and shows errors.
export async function busy(button, fn, errorHost) {
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

// A dialog with a form. Resolves with its values ({ name: value }, tick boxes as
// true/false), or null if cancelled. `validate(values)` may throw to keep it open.
export function modal(title, bodyNodes, { submitLabel = "OK", danger = false, cancel = true, wide = false, validate } = {}) {
  return new Promise((resolve) => {
    const err = h("div")
    const dlg = h("dialog", { class: wide ? "wide" : null })
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
      const data = {}
      for (const el of form.elements) {
        if (!el.name) continue
        if (el.type === "radio") {
          if (el.checked) data[el.name] = el.value
        } else {
          data[el.name] = el.type === "checkbox" ? el.checked : el.value
        }
      }
      try {
        if (validate) validate(data)
      } catch (er) {
        err.replaceChildren(errorBox(er))
        return
      }
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

export function showSecret(title, text, secret) {
  return modal(title, [h("p", {}, text), h("div", { class: "secret" }, secret)], { submitLabel: "Done", cancel: false })
}

export const fmtDate = (d) =>
  d ? new Date(d).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""

export const input = (name, label, attrs = {}, help) =>
  h("label", { class: "field" }, h("span", {}, label), h("input", { name, ...attrs }), help ? h("small", {}, help) : null)

export function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error("Use a PNG, JPEG, WebP or GIF image"))
    if (file.size > 500 * 1024) return reject(new Error("Image must be under 500 KB"))
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error("Couldn't read that file"))
    r.readAsDataURL(file)
  })
}

export function readText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(new Error("Couldn't read that file"))
    r.readAsText(file)
  })
}

// The shield logo; other icons are per dashboard.
export const SHIELD_SVG =
  '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor" opacity=".15"/><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

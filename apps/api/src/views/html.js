const { config } = require("../config")

const APP_NAME = () => config.appName

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

function layout({ title, body, scripts = "" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(APP_NAME())}</title>
<link rel="stylesheet" href="/assets/site.css">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
</head>
<body class="public">
<header class="topbar"><a class="brand" href="/">${brandMark()}<span>${esc(APP_NAME())}</span></a></header>
<main class="public-main">${body}</main>
<footer class="public-footer">${esc(APP_NAME())} · Tamper-evident documents</footer>
${scripts}
</body>
</html>`
}

const brandMark = () =>
  `<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="currentColor" opacity=".15"/><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m8.5 12 2.4 2.4 4.6-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function formatDate(d) {
  if (!d) return ""
  return new Date(d).toLocaleString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " UTC"
}

module.exports = { APP_NAME, esc, layout, formatDate, brandMark }

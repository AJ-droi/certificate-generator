const express = require("express")
const { repo } = require("../config/database")
const documents = require("../services/document.service")
const storage = require("../services/storage.service")
const renderCache = require("../lib/render-cache")
const { audit } = require("../lib/audit")
const { normalizePublicId } = require("../lib/crypto")
const { verifiedIdentity } = require("../services/org.service")
const { limiter } = require("../lib/rate-limit")
const { requestContext } = require("../lib/context")
const { config } = require("../config")
const { esc, layout, formatDate, APP_NAME } = require("../views/html")

const router = express.Router()

const verifyLimiter = limiter({ name: "verify", windowMs: 60 * 1000, limit: () => config.rateLimits.verify })

// ---- Landing ------------------------------------------------------------------

router.get("/", (req, res) => {
  res.send(
    layout({
      title: "Verify a document",
      body: `
<section class="hero">
  <h1>Is this document genuine?</h1>
  <p class="lead">Scan the QR code on the document, or enter the verification code printed next to it.</p>
  <form class="verify-form" action="/verify" method="get">
    <label for="code" class="sr-only">Verification code</label>
    <input id="code" name="code" placeholder="e.g. 7K2M-9QXA-…" autocomplete="off" autocapitalize="characters" required>
    <button class="btn primary" type="submit">Verify</button>
  </form>
</section>
<section class="split">
  <div class="panel">
    <h2>For companies</h2>
    <p>Upload your certificate and report templates, issue documents with a QR code, and let anyone confirm they're genuine.</p>
    <p class="row"><a class="btn primary" href="/app#/signup">Create a company account</a> <a class="btn" href="/app#/login">Sign in</a></p>
  </div>
  <div class="panel">
    <h2>How verification works</h2>
    <p>Every issued document is digitally signed by the company that issued it. If a single character is changed, the check fails — and revoked or replaced documents show up as no longer valid.</p>
  </div>
</section>`,
    }),
  )
})

router.get("/verify", (req, res) => {
  const code = normalizePublicId(req.query.code)
  if (!code) return res.redirect("/")
  res.redirect(`/v/${code}`)
})

// ---- Verification page ------------------------------------------------------------

function pdfNotReadyPage(res, doc) {
  res.status(503).setHeader("Retry-After", "30")
  res.send(
    layout({
      title: "PDF not ready yet",
      body: `
<div class="notice info"><strong>The official PDF is still being prepared.</strong> Try again in a minute. You can already <a href="/v/${esc(doc.publicId)}">check the document's details</a>.</div>`,
    }),
  )
}

function notFoundPage(res) {
  res.status(404).send(
    layout({
      title: "Not found",
      body: `
<div class="verdict verdict-bad">
  <div class="verdict-icon">✕</div>
  <div><h1>No document found</h1><p>This code doesn't match any document issued on ${esc(APP_NAME())}. Check the code, or treat the document as not verified.</p></div>
</div>
<p><a class="btn" href="/">Try another code</a></p>`,
    }),
  )
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })
const countryName = (code) => {
  try {
    return regionNames.of(code) || code
  } catch {
    return code
  }
}

const VERDICTS = {
  valid: {
    cls: "verdict-ok",
    icon: "✓",
    title: "Valid document",
    text: (r) => `Issued by <strong>${esc(r.issuer.verified.legalName)}</strong> (${esc(r.issuer.verified.domain)}) and unchanged since it was signed.`,
  },
  issuer_unverified: {
    cls: "verdict-warn",
    icon: "!",
    title: "Issuer not verified",
    text: (r) => `This document is unchanged since it was signed, but nobody has confirmed that the account calling itself <strong>${esc(r.issuer.name)}</strong> really is that company. Don't rely on it without checking with the company directly.`,
  },
  issuer_suspended: {
    cls: "verdict-bad",
    icon: "✕",
    title: "Issuer suspended — not valid",
    text: (r) => `The account that issued this document (<strong>${esc(r.issuer.name)}</strong>) has been suspended by ${esc(APP_NAME())}. Don't rely on it.`,
  },
  revoked: { cls: "verdict-bad", icon: "✕", title: "Revoked — not valid", text: (r) => `${esc(r.issuer.name)} revoked this document on ${esc(formatDate(r.revokedAt))}.` },
  superseded: { cls: "verdict-warn", icon: "!", title: "Replaced by a newer version", text: (r) => `${esc(r.issuer.name)} issued a correction. This version is no longer current.` },
  tampered: { cls: "verdict-bad", icon: "✕", title: "Failed integrity check", text: () => "This record doesn't match its digital signature. Don't rely on it, and contact the issuer." },
}

router.get("/v/:code", verifyLimiter, async (req, res) => {
  const doc = await documents.findForVerification(req.params.code)
  if (!doc) return notFoundPage(res)
  if (req.params.code !== doc.publicId) return res.redirect(301, `/v/${doc.publicId}`)
  const r = await documents.verificationReport(doc)
  await audit(req, "document.verified", {
    organizationId: doc.organizationId,
    entityType: "document",
    entityId: doc.id,
    details: { verdict: r.verdict, userAgent: String(req.get("user-agent") || "").slice(0, 200) },
  })

  const v = VERDICTS[r.verdict]
  const ident = r.issuer.verified
  const issuerCard = ident
    ? `<section class="card">
  <h2>Who issued it</h2>
  <p class="muted">${esc(APP_NAME())} checked this company's registration and that it controls its website domain.</p>
  <dl class="facts">
    <div><dt>Registered name</dt><dd>${esc(ident.legalName)}</dd></div>
    <div><dt>Registration number</dt><dd>${esc(ident.registrationNumber)} (${esc(countryName(ident.registrationCountry))})</dd></div>
    <div><dt>Website</dt><dd>${esc(ident.domain)}</dd></div>
    <div><dt>Verified since</dt><dd>${esc(formatDate(r.issuer.verifiedAt))}</dd></div>
  </dl>
  <p class="muted">If the company named on your document isn't this one, the document isn't genuine — even if everything else matches.</p>
</section>`
    : ""
  const facts = [
    ["Issued by", r.issuer.name],
    ["Document", r.templateName],
    ["Document number", r.documentNo],
    ["Issued", formatDate(r.issuedAt)],
    r.preparedBy && ["Prepared by", [r.preparedBy.name, r.preparedBy.qualification].filter(Boolean).join(" — ")],
    r.approvedBy && ["Approved by", [r.approvedBy.name, r.approvedBy.qualification].filter(Boolean).join(" — ")],
    ...r.fields.map((f) => [f.label, f.value]),
  ].filter(Boolean)

  const checks = [
    ["Digital signature", r.checks.signatureValid],
    ["Content fingerprint", r.checks.hashMatches],
    ["Record matches signed content", r.checks.recordMatches],
    [r.checks.pdfMatches === null ? "Official PDF (still being prepared)" : "Official PDF unchanged", r.checks.pdfMatches],
  ]
  const pdfReady = r.pdfStatus === "ready"

  res.setHeader("Cache-Control", "no-store")
  res.send(
    layout({
      title: `${r.documentNo} — ${v.title}`,
      body: `
<div class="verdict ${v.cls}">
  <div class="verdict-icon" aria-hidden="true">${v.icon}</div>
  <div><h1>${v.title}</h1><p>${v.text(r)}</p></div>
</div>
${r.status === "revoked" && r.revokeReason ? `<div class="notice bad"><strong>Reason:</strong> ${esc(r.revokeReason)}</div>` : ""}
${r.replacement ? `<div class="notice warn">Current version: <a href="/v/${esc(r.replacement.publicId)}">${esc(r.replacement.documentNo)}</a></div>` : ""}
${issuerCard}

<section class="card">
  <h2>Compare with the document you have</h2>
  <p class="muted">Every detail below should match the paper or PDF in front of you. If anything differs, the document has been altered.</p>
  <dl class="facts">${facts.map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val) || "—"}</dd></div>`).join("")}</dl>
  <div class="row">
    <a class="btn primary" href="/v/${esc(r.publicId)}/document" target="_blank" rel="noopener">View the full document</a>
    ${pdfReady ? `<a class="btn" href="/v/${esc(r.publicId)}/pdf">Download official PDF</a>` : `<span class="muted">The official PDF is still being prepared.</span>`}
  </div>
</section>

${pdfReady ? `<section class="card">
  <h2>Check a PDF you received</h2>
  <p class="muted">Pick the PDF file you were sent. It's checked in your browser and isn't uploaded.</p>
  <label class="file-drop"><input type="file" id="pdf-check" accept="application/pdf,.pdf"><span>Choose PDF…</span></label>
  <p id="pdf-result" class="check-result" role="status" data-expected="${esc(r.pdfHash)}"></p>
</section>` : ""}

<details class="card tech">
  <summary>Technical details</summary>
  <ul class="checks">${checks.map(([k, ok]) => `<li class="${ok === null ? "" : ok ? "ok" : "bad"}"><span>${ok === null ? "…" : ok ? "✓" : "✕"}</span>${esc(k)}</li>`).join("")}</ul>
  <dl class="facts mono">
    <div><dt>Verification code</dt><dd>${esc(r.verificationCode)}</dd></div>
    <div><dt>Signing key ID</dt><dd>${esc(r.issuer.keyId)} (Ed25519)</dd></div>
    <div><dt>Content SHA-256</dt><dd>${esc(r.contentHash)}</dd></div>
    <div><dt>PDF SHA-256</dt><dd>${esc(r.pdfHash) || "—"}</dd></div>
  </dl>
  <p class="muted">Signed data: <a href="/api/public/verify/${esc(r.publicId)}">JSON</a> · Issuer public key: <a href="/api/public/orgs/${esc(r.issuer.slug)}/key">${esc(r.issuer.slug)}</a></p>
</details>`,
      scripts: `<script src="/assets/verify.js" defer></script>`,
    }),
  )
})

router.get("/v/:code/document", verifyLimiter, async (req, res) => {
  const doc = await documents.findForVerification(req.params.code)
  if (!doc) return notFoundPage(res)
  const org = await repo("Organization").findOne({ where: { id: doc.organizationId } })
  const version = await repo("TemplateVersion").findOne({ where: { id: doc.templateVersionId } })
  const stamp = doc.status === "issued" ? null : documents.STAMPS[doc.status]
  const out = await documents.renderIssued(requestContext(req), doc, org, version, { stamp })
  if (out.kind === "pdf") return renderCache.sendPdf(res, out.body, `${doc.documentNo}.pdf`)
  let html = out.body
  if (doc.status !== "issued") {
    const label = doc.status === "revoked" ? "REVOKED" : "SUPERSEDED"
    const overlay = `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:2147483647"><span style="transform:rotate(-30deg);font:700 72px Arial;color:rgba(200,0,0,.25);border:6px solid rgba(200,0,0,.25);padding:12px 32px">${label}</span></div>`
    html = html.includes("</body>") ? html.replace("</body>", `${overlay}</body>`) : html + overlay
  }
  renderCache.sendSandboxed(res, html)
})

router.get("/v/:code/pdf", verifyLimiter, async (req, res) => {
  const doc = await documents.findForVerification(req.params.code)
  if (!doc) return notFoundPage(res)
  if (!documents.pdfReady(doc)) return pdfNotReadyPage(res, doc)
  const pdf = await storage.readFile(doc.pdfPath)
  res.setHeader("Content-Type", "application/pdf")
  res.setHeader("Content-Disposition", `inline; filename="${doc.documentNo.replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf"`)
  res.send(pdf)
})

// ---- Machine-readable verification -----------------------------------------------------

router.get("/api/public/verify/:code", verifyLimiter, async (req, res) => {
  const doc = await documents.findForVerification(req.params.code)
  if (!doc) return res.status(404).json({ verdict: "not_found" })
  const r = await documents.verificationReport(doc)
  await audit(req, "document.verified", {
    organizationId: doc.organizationId,
    entityType: "document",
    entityId: doc.id,
    details: { verdict: r.verdict, via: "api" },
  })
  res.setHeader("Cache-Control", "no-store")
  res.json({
    verdict: r.verdict,
    status: r.status,
    documentNo: r.documentNo,
    issuer: r.issuer,
    issuedAt: r.issuedAt,
    revokedAt: r.revokedAt,
    revokeReason: r.revokeReason,
    replacement: r.replacement,
    checks: r.checks,
    contentHash: r.contentHash,
    pdfHash: r.pdfHash,
    pdfStatus: r.pdfStatus,
    signature: r.signature,
    signatureAlgorithm: "Ed25519 over canonical JSON (sorted keys) of signedPayload",
    signedPayload: r.signedPayload,
  })
})

router.get("/api/public/orgs/:slug/key", verifyLimiter, async (req, res) => {
  const org = await repo("Organization").findOne({ where: { slug: String(req.params.slug) } })
  if (!org) return res.status(404).json({ message: "Not found" })
  res.json({
    organization: org.name,
    slug: org.slug,
    verificationStatus: org.verificationStatus,
    verified: verifiedIdentity(org),
    keyId: org.keyId,
    algorithm: "Ed25519",
    publicKey: org.publicKey,
  })
})

router.get("/api/public/config", (req, res) => {
  res.json({
    appName: APP_NAME(),
    allowSignup: config.allowSignup,
  })
})

// ---- Sandboxed previews for the dashboard -------------------------------------------

router.get("/render/:token", async (req, res) => {
  const out = await renderCache.get(req.params.token)
  if (!out) return res.status(404).send("Preview expired — reload it from the dashboard.")
  renderCache.send(res, out)
})

// ---- QR codes printed before this platform ------------------------------------------
// Old certificates point at /report/<certificate number>. If LEGACY_ORG_SLUG is set,
// those links redirect to the verify page of the imported document.

router.get("/report/*path", verifyLimiter, async (req, res) => {
  const slug = config.legacyOrgSlug
  const segments = [].concat(req.params.path || [])
  if (segments[segments.length - 1] === "generate") segments.pop()
  const documentNo = segments.join("/").trim().toUpperCase()
  if (!slug || !documentNo) return notFoundPage(res)
  const org = await repo("Organization").findOne({ where: { slug } })
  if (!org) return notFoundPage(res)
  const doc = await repo("Document").findOne({ where: { organizationId: org.id, documentNo } })
  if (!doc || !doc.publicId) return notFoundPage(res)
  res.redirect(302, `/v/${doc.publicId}`)
})

module.exports = router

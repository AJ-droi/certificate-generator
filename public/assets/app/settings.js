// Settings: profile, company, verification, signing key.
import { busy, fmtDate, h, readImage, toast } from "../lib/dom.js"
import { api } from "./api.js"
import { refresh } from "../lib/router.js"
import { pageHead, shell } from "./shell.js"
import { isAdmin, loadMe, state } from "./state.js"

// Every ISO country code the browser has a name for.
export function countryOptions() {
  const names = new Intl.DisplayNames([navigator.language || "en", "en"], { type: "region" })
  const out = []
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b)
      let name = code
      try { name = names.of(code) } catch {}
      if (name && name !== code && !/unknown/i.test(name)) out.push([code, name])
    }
  }
  return out.sort((x, y) => x[1].localeCompare(y[1]))
}

export const VERIFICATION_LABEL = {
  unverified: ["draft", "Not verified"],
  pending: ["pending_approval", "Under review"],
  verified: ["issued", "Verified"],
  rejected: ["revoked", "Not approved"],
  suspended: ["revoked", "Suspended"],
}

export function verificationCard(org) {
  const v = org.verification
  const [cls, label] = VERIFICATION_LABEL[v.status] || VERIFICATION_LABEL.unverified
  const err = h("div")
  const head = h("div", { class: "row" }, h("h2", {}, "Company verification"), h("span", { class: `badge ${cls}` }, label))
  const intro = h("p", { class: "muted" },
    "Partners who scan your QR codes see your registered name, registration number and website, checked by us. ",
    "This stops anyone else signing up under your name and issuing documents that look like yours. Documents can only be issued once your company is verified.")

  const details = h("dl", { class: "kv" },
    h("dt", {}, "Registered name"), h("dd", {}, v.legalName || "—"),
    h("dt", {}, "Registration no."), h("dd", {}, v.registrationNumber ? `${v.registrationNumber} (${v.registrationCountry})` : "—"),
    h("dt", {}, "Website domain"), h("dd", {}, v.domain ? `${v.domain} ${v.domainVerified ? "✓ proven" : "— not proven yet"}` : "—"),
    v.verifiedAt ? [h("dt", {}, "Verified"), h("dd", {}, fmtDate(v.verifiedAt))] : null,
  )

  if (["verified", "suspended"].includes(v.status)) {
    return h("section", { class: "card stack" }, head, intro, details,
      v.status === "suspended" ? h("div", { class: "notice bad" }, h("strong", {}, "Suspended: "), v.note || "") : null,
      h("small", { class: "muted" }, "These details are locked. Contact support if they change."))
  }
  if (!isAdmin()) {
    return h("section", { class: "card stack" }, head, intro, v.legalName ? details : h("p", {}, "An admin needs to request verification."))
  }

  const model = {
    legalName: v.legalName || org.name,
    registrationNumber: v.registrationNumber || "",
    registrationCountry: v.registrationCountry || "",
    domain: v.domain || "",
  }
  const country = h("select", { onchange: (e) => { model.registrationCountry = e.target.value } },
    h("option", { value: "" }, "Choose…"),
    countryOptions().map(([code, name]) => {
      const o = h("option", { value: code }, name)
      if (code === model.registrationCountry) o.selected = true
      return o
    }))
  const submit = h("button", { class: "btn primary", onclick: () => busy(submit, async () => {
    await api("POST", "/api/org/verification", model)
    await loadMe()
    toast("Verification requested")
    refresh()
  }, err) }, v.status === "pending" ? "Update request" : "Request verification")

  let dns = null
  if (v.dnsRecord && !v.domainVerified) {
    const check = h("button", { class: "btn", onclick: () => busy(check, async () => {
      const r = await api("POST", "/api/org/verification/check-domain", {})
      await loadMe()
      if (r.found) {
        toast("Domain proven")
        refresh()
      } else {
        toast("Record not found yet. DNS changes can take up to an hour to appear.", true)
      }
    }, err) }, "Check DNS record")
    dns = h("div", { class: "notice info stack" },
      h("div", {}, h("strong", {}, `Prove you control ${v.domain}`)),
      h("div", {}, "Ask whoever manages your domain to add this TXT record, then check it here. You can remove it after you're verified."),
      h("dl", { class: "kv" },
        h("dt", {}, "Name / host"), h("dd", { class: "secret" }, v.dnsRecord.name),
        h("dt", {}, "Type"), h("dd", {}, v.dnsRecord.type),
        h("dt", {}, "Value"), h("dd", { class: "secret" }, v.dnsRecord.value)),
      h("div", { class: "row" }, check))
  }

  return h("section", { class: "card stack" }, head, intro,
    v.status === "rejected" ? h("div", { class: "notice bad" }, h("strong", {}, "Not approved: "), v.note || "", " Correct your details and send them again.") : null,
    v.status === "pending" ? h("div", { class: "notice info" }, `Requested ${fmtDate(v.requestedAt)}. We're checking your registration with the official registry.`) : null,
    h("div", { class: "grid-2" },
      h("label", { class: "field" }, h("span", {}, "Registered company name"), h("input", { value: model.legalName, oninput: (e) => { model.legalName = e.target.value } }),
        h("small", {}, "Exactly as on your certificate of incorporation")),
      h("label", { class: "field" }, h("span", {}, "Registration number"), h("input", { value: model.registrationNumber, placeholder: "e.g. RC 123456", oninput: (e) => { model.registrationNumber = e.target.value } })),
      h("label", { class: "field" }, h("span", {}, "Country of registration"), country),
      h("label", { class: "field" }, h("span", {}, "Website domain"), h("input", { value: model.domain, placeholder: "example.com", oninput: (e) => { model.domain = e.target.value } }),
        h("small", {}, "Your company's own domain — you'll prove you control it")),
    ),
    err,
    h("div", { class: "row" }, submit),
    dns)
}

export async function settingsScreen() {
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
      value ? h("button", { class: "btn small ghost", type: "button", onclick: () => { value = null; onPick(null); draw() } }, "Remove") : "",
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

  const nameLocked = ["verified", "suspended"].includes(org.verification.status)

  shell("settings",
    pageHead("Settings"),
    h("div", { class: "stack", style: "max-width:760px" },
      verificationCard(org),
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
            h("label", { class: "field" }, h("span", {}, "Company name"),
              h("input", { value: orgModel.name, disabled: nameLocked, oninput: (e) => { orgModel.name = e.target.value } }),
              h("small", {}, nameLocked ? "Locked because your company is verified. Contact support to change it." : "Shown to partners on the verify page.")),
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

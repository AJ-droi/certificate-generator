// Settings: company verification, your profile, company settings, signing key.
import { useMemo, useState } from "react"
import { Link } from "react-router"
import type { Organization } from "@doctrust/shared"
import { api } from "../api"
import { useMe } from "../session"
import { fmtDate, readImage } from "../../shared/format"
import { errorMessage } from "../../shared/api"
import { AsyncButton } from "../../shared/ui/AsyncButton"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { PageHead } from "../../shared/ui/common"
import { useToast } from "../../shared/ui/Toasts"

export function Settings() {
  const { org } = useMe()
  return (
    <>
      <PageHead title="Settings" />
      <div className="stack" style={{ maxWidth: 760 }}>
        <VerificationCard org={org} />
        <ProfileCard />
        <CompanyCard />
        <section className="card">
          <h2>Signing key</h2>
          <p className="muted">Every document you issue is signed with your company's private key, which never leaves the server. Partners can check signatures with this public key.</p>
          <dl className="kv">
            <dt>Company ID</dt><dd className="mono">{org.slug}</dd>
            <dt>Key ID</dt><dd className="mono">{org.keyId}</dd>
            <dt>Algorithm</dt><dd>Ed25519</dd>
          </dl>
          <pre className="mono" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", padding: 10, borderRadius: 8, marginTop: 10 }}>{org.publicKey}</pre>
        </section>
      </div>
    </>
  )
}

function ImagePicker({ value, onChange, label }: { value: string | null; onChange: (v: string | null) => void; label: string }) {
  const toast = useToast()
  return (
    <div className="img-field">
      {value ? <img src={value} alt="" /> : <span className="muted">None</span>}
      <label className="btn small">
        Upload {label}
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }} onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            onChange(await readImage(file))
          } catch (err) {
            toast(errorMessage(err), true)
          }
        }} />
      </label>
      {value ? <button className="btn small ghost" type="button" onClick={() => onChange(null)}>Remove</button> : null}
    </div>
  )
}

function ProfileCard() {
  const { me, reload } = useMe()
  const toast = useToast()
  const [profile, setProfile] = useState({ name: me.name, qualification: me.qualification || "", signature: me.signature })
  const [error, setError] = useState<unknown>(null)
  return (
    <section className="card stack">
      <h2>Your profile</h2>
      <p className="muted">Your name, qualification and signature appear on documents you prepare or approve.</p>
      <div className="grid-2">
        <label className="field">
          <span>Name</span>
          <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
        </label>
        <label className="field">
          <span>Qualification</span>
          <input value={profile.qualification} placeholder="e.g. ASNT Level II, LEEA Diploma" onChange={(e) => setProfile({ ...profile, qualification: e.target.value })} />
        </label>
      </div>
      <div className="field">
        <label className="field"><span>Signature</span></label>
        <ImagePicker value={profile.signature} onChange={(signature) => setProfile({ ...profile, signature })} label="signature" />
        <small className="muted">A PNG with a transparent background looks best.</small>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <AsyncButton className="btn primary" onError={setError} onClick={async () => {
          await api("PATCH", "/api/me", profile)
          await reload()
          toast("Profile saved")
        }}>Save profile</AsyncButton>
        <Link className="btn" to="/change-password">Change password</Link>
      </div>
    </section>
  )
}

function CompanyCard() {
  const { org, isAdmin, reload } = useMe()
  const toast = useToast()
  const [company, setCompany] = useState({ name: org.name, logo: org.logo, requireSeparateApprover: org.requireSeparateApprover })
  const [error, setError] = useState<unknown>(null)
  if (!isAdmin) return null
  const nameLocked = ["verified", "suspended"].includes(org.verification.status)
  return (
    <section className="card stack">
      <h2>Company</h2>
      <label className="field">
        <span>Company name</span>
        <input value={company.name} disabled={nameLocked} onChange={(e) => setCompany({ ...company, name: e.target.value })} />
        <small>{nameLocked ? "Locked because your company is verified. Contact support to change it." : "Shown to partners on the verify page."}</small>
      </label>
      <div className="field">
        <label className="field"><span>Logo</span></label>
        <ImagePicker value={company.logo} onChange={(logo) => setCompany({ ...company, logo })} label="logo" />
      </div>
      <label className="check">
        <input type="checkbox" checked={company.requireSeparateApprover} onChange={(e) => setCompany({ ...company, requireSeparateApprover: e.target.checked })} />
        Require a second person to approve (recommended)
      </label>
      <small className="muted">When on, nobody can approve a document they prepared themselves.</small>
      <ErrorBox error={error} />
      <div className="row">
        <AsyncButton className="btn primary" onError={setError} onClick={async () => {
          await api("PATCH", "/api/org", company)
          await reload()
          toast("Company settings saved")
        }}>Save company settings</AsyncButton>
      </div>
    </section>
  )
}

// Every ISO country code the browser has a name for.
function useCountries(): Array<[string, string]> {
  return useMemo(() => {
    const names = new Intl.DisplayNames([navigator.language || "en", "en"], { type: "region" })
    const out: Array<[string, string]> = []
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b)
        let name: string | undefined
        try {
          name = names.of(code)
        } catch {
          name = undefined
        }
        if (name && name !== code && !/unknown/i.test(name)) out.push([code, name])
      }
    }
    return out.sort((x, y) => x[1].localeCompare(y[1]))
  }, [])
}

const VERIFICATION_LABEL: Record<string, [string, string]> = {
  unverified: ["draft", "Not verified"],
  pending: ["pending_approval", "Under review"],
  verified: ["issued", "Verified"],
  rejected: ["revoked", "Not approved"],
  suspended: ["revoked", "Suspended"],
}

function VerificationCard({ org }: { org: Organization }) {
  const { isAdmin, reload } = useMe()
  const toast = useToast()
  const countries = useCountries()
  const v = org.verification
  const [cls, label] = VERIFICATION_LABEL[v.status] || VERIFICATION_LABEL.unverified
  const [error, setError] = useState<unknown>(null)
  const [form, setForm] = useState({
    legalName: v.legalName || org.name,
    registrationNumber: v.registrationNumber || "",
    registrationCountry: v.registrationCountry || "",
    domain: v.domain || "",
  })

  const head = (
    <div className="row">
      <h2>Company verification</h2>
      <span className={`badge ${cls}`}>{label}</span>
    </div>
  )
  const intro = (
    <p className="muted">
      Partners who scan your QR codes see your registered name, registration number and website, checked by us. This stops anyone else signing up under your name and issuing documents that look like yours. Documents can only be issued once your company is verified.
    </p>
  )
  const details = (
    <dl className="kv">
      <dt>Registered name</dt><dd>{v.legalName || "—"}</dd>
      <dt>Registration no.</dt><dd>{v.registrationNumber ? `${v.registrationNumber} (${v.registrationCountry})` : "—"}</dd>
      <dt>Website domain</dt><dd>{v.domain ? `${v.domain} ${v.domainVerified ? "✓ proven" : "— not proven yet"}` : "—"}</dd>
      {v.verifiedAt ? <><dt>Verified</dt><dd>{fmtDate(v.verifiedAt)}</dd></> : null}
    </dl>
  )

  if (v.status === "verified" || v.status === "suspended") {
    return (
      <section className="card stack">
        {head}
        {intro}
        {details}
        {v.status === "suspended" ? <div className="notice bad"><strong>Suspended: </strong>{v.note || ""}</div> : null}
        <small className="muted">These details are locked. Contact support if they change.</small>
      </section>
    )
  }
  if (!isAdmin) {
    return <section className="card stack">{head}{intro}{v.legalName ? details : <p>An admin needs to request verification.</p>}</section>
  }

  return (
    <section className="card stack">
      {head}
      {intro}
      {v.status === "rejected" ? <div className="notice bad"><strong>Not approved: </strong>{v.note || ""} Correct your details and send them again.</div> : null}
      {v.status === "pending" ? <div className="notice info">Requested {fmtDate(v.requestedAt)}. We're checking your registration with the official registry.</div> : null}
      <div className="grid-2">
        <label className="field">
          <span>Registered company name</span>
          <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
          <small>Exactly as on your certificate of incorporation</small>
        </label>
        <label className="field">
          <span>Registration number</span>
          <input value={form.registrationNumber} placeholder="e.g. RC 123456" onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} />
        </label>
        <label className="field">
          <span>Country of registration</span>
          <select value={form.registrationCountry} onChange={(e) => setForm({ ...form, registrationCountry: e.target.value })}>
            <option value="">Choose…</option>
            {countries.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Website domain</span>
          <input value={form.domain} placeholder="example.com" onChange={(e) => setForm({ ...form, domain: e.target.value })} />
          <small>Your company's own domain — you'll prove you control it</small>
        </label>
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <AsyncButton className="btn primary" onError={setError} onClick={async () => {
          await api("POST", "/api/org/verification", form)
          await reload()
          toast("Verification requested")
        }}>{v.status === "pending" ? "Update request" : "Request verification"}</AsyncButton>
      </div>
      {v.dnsRecord && !v.domainVerified ? (
        <div className="notice info stack">
          <div><strong>Prove you control {v.domain}</strong></div>
          <div>Ask whoever manages your domain to add this TXT record, then check it here. You can remove it after you're verified.</div>
          <dl className="kv">
            <dt>Name / host</dt><dd className="secret">{v.dnsRecord.name}</dd>
            <dt>Type</dt><dd>{v.dnsRecord.type}</dd>
            <dt>Value</dt><dd className="secret">{v.dnsRecord.value}</dd>
          </dl>
          <div className="row">
            <AsyncButton onError={setError} onClick={async () => {
              const r = await api<{ found: boolean }>("POST", "/api/org/verification/check-domain", {})
              await reload()
              if (r.found) toast("Domain proven")
              else toast("Record not found yet. DNS changes can take up to an hour to appear.", true)
            }}>Check DNS record</AsyncButton>
          </div>
        </div>
      ) : null}
    </section>
  )
}

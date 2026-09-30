// One company: identity, warnings, usage, people, documents, activity — and the
// verification decisions (verify, reject, suspend, reinstate, check DNS).
import { useState, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { CompanyDetail } from "@doctrust/shared"
import { api } from "../api"
import { detailText, fmtDate, fmtDay } from "../../shared/format"
import { AsyncButton } from "../../shared/ui/AsyncButton"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { Loading, PageError, PageHead } from "../../shared/ui/common"
import { useDialogs } from "../../shared/ui/Dialogs"
import { useToast } from "../../shared/ui/Toasts"
import { StatusBadge, VERDICT } from "./parts"

export function Company() {
  const { id = "" } = useParams()
  const q = useQuery({ queryKey: ["company", id], queryFn: () => api<CompanyDetail>("GET", `/companies/${id}`) })
  if (q.error) return <PageError error={q.error} back={{ href: "/platform/companies", label: "Back to companies" }} />
  if (!q.data) return <Loading />
  return <CompanyView id={id} d={q.data} />
}

function KV({ rows }: { rows: Array<[string, ReactNode] | null> }) {
  return (
    <dl className="kv">
      {rows.filter((r): r is [string, ReactNode] => Boolean(r)).map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === "" ? "—" : v}</dd>
        </div>
      ))}
    </dl>
  )
}

function CompanyView({ id, d }: { id: string; d: CompanyDetail }) {
  const org = d.organization
  const v = org.verification
  const queries = useQueryClient()
  const dialogs = useDialogs()
  const toast = useToast()
  const [error, setError] = useState<unknown>(null)
  const refresh = () => {
    queries.invalidateQueries({ queryKey: ["company", id] })
    queries.invalidateQueries({ queryKey: ["companies"] })
    queries.invalidateQueries({ queryKey: ["overview"] })
  }

  const verify = async () => {
    const answer = await dialogs.form(v.status === "suspended" ? "Reinstate this company?" : "Verify this company?", (
      <>
        <p className="muted">Partners will see these details on every document the company issues. Correct anything that doesn't match the registry.</p>
        <div className="grid-2">
          <label className="field"><span>Registered name</span><input name="legalName" defaultValue={v.legalName || org.name} required /></label>
          <label className="field"><span>Registration number</span><input name="registrationNumber" defaultValue={v.registrationNumber || ""} required /></label>
          <label className="field"><span>Country (2-letter code)</span><input name="registrationCountry" defaultValue={v.registrationCountry || ""} required maxLength={2} style={{ textTransform: "uppercase" }} /></label>
          <label className="field"><span>Website domain</span><input name="domain" defaultValue={v.domain || ""} required /></label>
        </div>
        <label className="check">
          <input type="checkbox" name="registryChecked" />
          I checked the name and registration number with the official company registry, and that the person who applied works there.
        </label>
        {v.domainVerified ? (
          <p className="muted">✓ {v.domain} proven by DNS record.</p>
        ) : (
          <label className="check">
            <input type="checkbox" name="trustDomain" />
            The DNS record for {v.domain || "the domain"} isn't there. I confirmed they control it another way (e.g. email to an address on the domain).
          </label>
        )}
      </>
    ), {
      submitLabel: v.status === "suspended" ? "Reinstate" : "Verify",
      validate: (x) => {
        if (!x.registryChecked) throw new Error("Tick the box to confirm you checked the registry")
      },
    })
    if (!answer) return
    await api("POST", `/companies/${id}/verify`, { ...answer, registrationCountry: String(answer.registrationCountry || "").toUpperCase() })
    toast("Company verified")
    refresh()
  }

  const decide = (path: "reject" | "suspend", title: string, intro: ReactNode, placeholder: string, done: string) => async () => {
    const answer = await dialogs.form(title, (
      <>
        {intro}
        <label className="field"><span>Reason (the company sees this)</span><textarea name="reason" rows={3} required placeholder={placeholder} /></label>
      </>
    ), { submitLabel: path === "reject" ? "Reject" : "Suspend", danger: true })
    if (!answer) return
    await api("POST", `/companies/${id}/${path}`, answer)
    toast(done)
    refresh()
  }

  const actions: ReactNode[] = []
  if (v.dnsRecord && !v.domainVerified && v.status !== "verified") {
    actions.push(
      <AsyncButton key="dns" onError={setError} onClick={async () => {
        const r = await api<{ found: boolean }>("POST", `/companies/${id}/check-dns`, {})
        toast(r.found ? "DNS record found — domain proven" : "DNS record not found", !r.found)
        refresh()
      }}>Check DNS now</AsyncButton>,
    )
  }
  if (["pending", "unverified", "rejected"].includes(v.status)) {
    actions.push(
      <AsyncButton key="reject" className="btn danger" onError={setError} onClick={decide("reject", "Reject this request?", null, "e.g. The registration number doesn't match the company name", "Request rejected")}>Reject</AsyncButton>,
      <AsyncButton key="verify" className="btn primary" onError={setError} onClick={verify}>Verify company</AsyncButton>,
    )
  }
  if (v.status === "verified") {
    actions.push(
      <AsyncButton key="suspend" className="btn danger" onError={setError} onClick={decide(
        "suspend",
        "Suspend this company?",
        <p>It won't be able to issue documents, and every document it has issued will show as <strong>Issuer suspended — not valid</strong> when scanned. It can still revoke documents.</p>,
        "",
        "Company suspended",
      )}>Suspend</AsyncButton>,
    )
  }
  if (v.status === "suspended") actions.push(<AsyncButton key="reinstate" className="btn primary" onError={setError} onClick={verify}>Reinstate</AsyncButton>)

  // Things to look at before verifying (or signs of abuse after).
  const warnings: ReactNode[] = []
  if (d.warnings.similar.length) {
    warnings.push(
      <li key="similar">
        The name looks like verified companies — check this isn't an impersonation:{" "}
        {d.warnings.similar.map((o, i) => (
          <span key={o.id}>{i ? ", " : ""}<Link to={`/companies/${o.id}`}>{o.name}</Link> ({o.domain})</span>
        ))}
      </li>,
    )
  }
  if (d.warnings.adminsOffDomain.length) warnings.push(<li key="email">Admin email not on {v.domain}: {d.warnings.adminsOffDomain.join(", ")}</li>)
  if (v.domain && !v.domainVerified) warnings.push(<li key="dns">{v.domain} hasn't been proven with its DNS record.</li>)
  const invalid = Object.entries(d.scans30).filter(([k]) => k !== "valid").reduce((a, [, n]) => a + n, 0)
  if (invalid) warnings.push(<li key="scans">{invalid} scan{invalid === 1 ? "" : "s"} of invalid documents in the last 30 days.</li>)

  const docs = d.documents
  const scans = Object.entries(d.scans30)

  return (
    <>
      <PageHead title={v.legalName || org.name} sub={<span className="row"><StatusBadge status={v.status} /><span className="mono">{org.slug}</span></span>} actions={actions} />
      <ErrorBox error={error} />
      {v.note && (v.status === "rejected" || v.status === "suspended") ? (
        <div className="notice bad" style={{ marginBottom: 16 }}><strong>{v.status === "suspended" ? "Suspended: " : "Rejected: "}</strong>{v.note}</div>
      ) : null}
      {warnings.length ? (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          <strong>Check before trusting</strong>
          <ul className="warn-list">{warnings}</ul>
        </div>
      ) : null}
      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card stack">
          <h2>Identity</h2>
          <KV rows={[
            ["Name on account", org.name],
            ["Registered name", v.legalName],
            ["Registration no.", v.registrationNumber ? `${v.registrationNumber} (${v.registrationCountry})` : null],
            ["Website domain", v.domain ? `${v.domain} ${v.domainVerified ? "✓ proven" : "— not proven"}` : null],
            v.dnsRecord && !v.domainVerified ? ["DNS record", <span className="mono">{`${v.dnsRecord.name} TXT "${v.dnsRecord.value}"`}</span>] : null,
            ["Signed up", fmtDate(org.createdAt, "—")],
            ["Requested", fmtDate(v.requestedAt, "—")],
            ["Verified", v.verifiedAt ? `${fmtDate(v.verifiedAt)} by ${org.verifiedBy}` : null],
            ["Signing key", <span className="mono">{org.keyId}</span>],
          ]} />
        </section>
        <section className="card stack">
          <h2>Usage</h2>
          <KV rows={[
            ["Templates", String(d.templates)],
            ["Issued", String((docs.issued || 0) + (docs.revoked || 0) + (docs.superseded || 0))],
            ["Revoked", String(docs.revoked || 0)],
            ["Drafts / waiting", `${docs.draft || 0} / ${docs.pending_approval || 0}`],
            ["Scans (30 days)", scans.length ? scans.map(([k, n]) => `${VERDICT[k] || k}: ${n}`).join(" · ") : "None"],
          ]} />
        </section>
      </div>
      <section className="stack" style={{ marginTop: 20 }}>
        <h2>People</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Added</th></tr></thead>
            <tbody>
              {d.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}{u.active ? "" : <span className="muted"> (disabled)</span>}</td>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td className="muted">{fmtDay(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {d.recentDocuments.length ? (
        <section className="stack" style={{ marginTop: 20 }}>
          <h2>Recent documents</h2>
          <p className="muted">Numbers and status only. Issued ones link to their public verify page.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Number</th><th>Status</th><th>Issued</th></tr></thead>
              <tbody>
                {d.recentDocuments.map((doc) => (
                  <tr key={doc.id}>
                    <td>{doc.publicId ? <a href={`/v/${doc.publicId}`} target="_blank" rel="noopener">{doc.documentNo}</a> : doc.documentNo}</td>
                    <td>{doc.status.replace("_", " ")}</td>
                    <td className="muted">{fmtDate(doc.issuedAt, "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <section className="stack" style={{ marginTop: 20 }}>
        <h2>Recent activity</h2>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
            <tbody>
              {d.events.map((e) => (
                <tr key={e.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{fmtDate(e.createdAt, "—")}</td>
                  <td>{e.who}</td>
                  <td>{e.action}</td>
                  <td className="muted" style={{ fontSize: ".85rem", maxWidth: 380, overflowWrap: "anywhere" }}>{detailText(e.details, ["staffId", "staff"])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

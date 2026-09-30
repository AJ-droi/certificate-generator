// Pieces shared by the staff screens.
import { useNavigate } from "react-router"
import type { ReactNode } from "react"
import type { CompanyRow, VerificationStatus } from "@doctrust/shared"

const STATUS: Record<VerificationStatus, [string, string]> = {
  pending: ["pending_approval", "Waiting for review"],
  unverified: ["draft", "Not applied"],
  verified: ["issued", "Verified"],
  rejected: ["superseded", "Rejected"],
  suspended: ["revoked", "Suspended"],
}

export function StatusBadge({ status }: { status: VerificationStatus }) {
  const [cls, label] = STATUS[status] || [status, status]
  return <span className={`badge ${cls}`}>{label}</span>
}

export const VERDICT: Record<string, string> = {
  valid: "Valid",
  tampered: "Failed integrity check",
  revoked: "Revoked",
  superseded: "Superseded",
  issuer_unverified: "Issuer not verified",
  issuer_suspended: "Issuer suspended",
}

export const NameCell = ({ c }: { c: CompanyRow }) => (
  <div>
    <div style={{ fontWeight: 600 }}>{c.legalName || c.name}</div>
    <div className="muted" style={{ fontSize: ".85rem" }}>{c.legalName && c.legalName !== c.name ? `${c.name} · ${c.slug}` : c.slug}</div>
  </div>
)

export const DomainCell = ({ c }: { c: CompanyRow }) =>
  c.domain ? (
    <span>
      {c.domain}{" "}
      {c.domainVerified ? <span title="DNS record found" style={{ color: "var(--ok)" }}>✓</span> : <span className="muted" title="Not proven yet">(not proven)</span>}
    </span>
  ) : <>—</>

export type Column = [label: string, cell: (c: CompanyRow) => ReactNode, cls?: string]

export function CompanyTable({ rows, columns }: { rows: CompanyRow[]; columns: Column[] }) {
  const navigate = useNavigate()
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>{columns.map(([label, , cls]) => <th key={label} className={cls}>{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="clickable" onClick={() => navigate(`/companies/${c.id}`)}>
              {columns.map(([label, cell, cls]) => <td key={label} className={cls}>{cell(c)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// People: invite, change roles, reset passwords, deactivate.
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Role, User } from "@doctrust/shared"
import { api } from "../api"
import { useMe } from "../session"
import { errorMessage } from "../../shared/api"
import { Loading, PageError, PageHead } from "../../shared/ui/common"
import { useDialogs } from "../../shared/ui/Dialogs"
import { useToast } from "../../shared/ui/Toasts"

const ROLES: Role[] = ["issuer", "approver", "admin"]
const ROLE_HELP: Record<Role, string> = { admin: "Everything, incl. templates & people", approver: "Approves, issues and revokes", issuer: "Prepares documents" }

export function People() {
  const { me, isAdmin } = useMe()
  const queries = useQueryClient()
  const dialogs = useDialogs()
  const toast = useToast()
  const users = useQuery({ queryKey: ["users"], queryFn: async () => (await api<{ users: User[] }>("GET", "/api/users")).users })
  const refresh = () => queries.invalidateQueries({ queryKey: ["users"] })
  const attempt = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (err) {
      toast(errorMessage(err), true)
      refresh()
    }
  }

  const addPerson = async () => {
    const data = await dialogs.form("Add a person", (
      <>
        <label className="field"><span>Name</span><input name="name" required /></label>
        <label className="field"><span>Email</span><input name="email" type="email" required /></label>
        <label className="field">
          <span>Role</span>
          <select name="role" defaultValue="issuer">
            {ROLES.map((r) => <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>)}
          </select>
        </label>
      </>
    ), { submitLabel: "Add" })
    if (!data) return
    await attempt(async () => {
      const r = await api<{ user: User; temporaryPassword: string }>("POST", "/api/users", data)
      await dialogs.secret("Share this temporary password", `Give ${r.user.name} this password. They'll choose their own when they first sign in. It won't be shown again.`, r.temporaryPassword)
      refresh()
    })
  }

  if (users.error) return <PageError error={users.error} back={{ href: "/app/documents", label: "Back to documents" }} />
  if (!users.data) return <Loading />

  return (
    <>
      <PageHead title="People" sub="Who can prepare, approve and manage documents." actions={isAdmin ? <button className="btn primary" onClick={addPerson}>Add person</button> : null} />
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Signature</th>
              <th>Status</th>
              {isAdmin ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <tr key={u.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{u.name}</div>
                  <div className="muted" style={{ fontSize: ".85rem" }}>{u.email}</div>
                </td>
                <td>
                  {isAdmin && u.id !== me.id ? (
                    <select style={{ minWidth: 120 }} defaultValue={u.role} onChange={(e) => attempt(async () => {
                      await api("PATCH", `/api/users/${u.id}`, { role: e.target.value })
                      toast("Role updated")
                    })}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  ) : u.role}
                </td>
                <td>{u.signature ? <img src={u.signature} alt="" style={{ height: 28, background: "#fff", borderRadius: 4 }} /> : <span className="muted">—</span>}</td>
                <td>
                  {u.active
                    ? u.mustChangePassword ? <span className="badge pending_approval">Invited</span> : <span className="badge issued">Active</span>
                    : <span className="badge">Deactivated</span>}
                </td>
                {isAdmin ? (
                  <td style={{ textAlign: "right" }}>
                    {u.id === me.id ? null : (
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button className="btn small" onClick={async () => {
                          if (!(await dialogs.confirm(`Reset ${u.name}'s password?`, <p>They'll get a new temporary password and be signed out.</p>, { submitLabel: "Reset" }))) return
                          await attempt(async () => {
                            const r = await api<{ temporaryPassword: string }>("POST", `/api/users/${u.id}/reset-password`, {})
                            await dialogs.secret("New temporary password", `Give this to ${u.name}.`, r.temporaryPassword)
                            refresh()
                          })
                        }}>Reset password</button>
                        <button className={`btn small ${u.active ? "danger" : ""}`} onClick={() => attempt(async () => {
                          await api("PATCH", `/api/users/${u.id}`, { active: !u.active })
                          toast(u.active ? "Deactivated" : "Reactivated")
                          refresh()
                        })}>{u.active ? "Deactivate" : "Reactivate"}</button>
                      </div>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginTop: 12, fontSize: ".9rem" }}>Each person adds their own signature in Settings. It's placed on a document only when they prepare or approve it.</p>
    </>
  )
}

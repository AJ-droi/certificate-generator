// Sign in, sign up, and choosing a new password.
import { useState, type FormEvent, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { api } from "../api"
import { useSession } from "../session"
import { Brand, Input } from "../../shared/ui/common"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { useToast } from "../../shared/ui/Toasts"

function AuthCard({ title, sub, submitLabel, onSubmit, footer, children }: {
  title: string
  sub?: string | null
  submitLabel: string
  onSubmit: (values: Record<string, string>) => Promise<void>
  footer?: ReactNode
  children: ReactNode
}) {
  const { config } = useSession()
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const values = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>
    setBusy(true)
    setError(null)
    try {
      await onSubmit(values)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <Brand appName={config.appName} />
        <h1>{title}</h1>
        {sub ? <p className="muted">{sub}</p> : null}
        <form onSubmit={submit}>
          {children}
          <ErrorBox error={error} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Working…" : submitLabel}
          </button>
        </form>
        {footer}
      </div>
    </div>
  )
}

export function Login() {
  const { config, reload } = useSession()
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from
  return (
    <AuthCard
      title="Sign in"
      sub="Sign in to issue and manage your company's documents."
      submitLabel="Sign in"
      onSubmit={async (values) => {
        const r = await api<{ user: { mustChangePassword: boolean } }>("POST", "/api/auth/login", values)
        await reload()
        navigate(r.user.mustChangePassword ? "/change-password" : from || "/documents", { replace: true })
      }}
      footer={
        config.allowSignup ? (
          <p className="muted" style={{ marginTop: 16 }}>
            New company? <Link to="/signup">Create an account</Link>
          </p>
        ) : null
      }
    >
      <Input name="email" label="Email" type="email" autoComplete="username" required autoFocus />
      <Input name="password" label="Password" type="password" autoComplete="current-password" required />
    </AuthCard>
  )
}

export function Signup() {
  const { reload } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  return (
    <AuthCard
      title="Create your company account"
      sub="You'll be the admin. You can invite your team afterwards."
      submitLabel="Create account"
      onSubmit={async (values) => {
        await api("POST", "/api/auth/signup", values)
        await reload()
        navigate("/templates", { replace: true })
        toast("Account created. Start by adding a template.")
      }}
      footer={
        <p className="muted" style={{ marginTop: 16 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <Input name="orgName" label="Company name" required autoComplete="organization" autoFocus />
      <Input name="name" label="Your name" required autoComplete="name" />
      <Input name="email" label="Work email" type="email" required autoComplete="username" />
      <Input name="password" label="Password" type="password" required minLength={10} autoComplete="new-password" help="At least 10 characters" />
    </AuthCard>
  )
}

export function ChangePassword() {
  const { me, reload } = useSession()
  const navigate = useNavigate()
  const toast = useToast()
  return (
    <AuthCard
      title="Set a new password"
      sub={me?.mustChangePassword ? "You signed in with a temporary password. Choose your own to continue." : null}
      submitLabel="Save password"
      onSubmit={async (values) => {
        await api("POST", "/api/auth/password", values)
        await reload()
        toast("Password updated")
        navigate("/documents", { replace: true })
      }}
    >
      <Input name="currentPassword" label="Current (temporary) password" type="password" required autoComplete="current-password" autoFocus />
      <Input name="newPassword" label="New password" type="password" required minLength={10} autoComplete="new-password" help="At least 10 characters" />
    </AuthCard>
  )
}

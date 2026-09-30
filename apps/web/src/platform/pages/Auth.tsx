// Staff sign-in and authenticator-app setup.
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { api } from "../api"
import { useStaffSession } from "../session"
import { Brand, Input } from "../../shared/ui/common"
import { ErrorBox } from "../../shared/ui/ErrorBox"
import { useToast } from "../../shared/ui/Toasts"

function Card({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  const { appName } = useStaffSession()
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <Brand appName={appName} href="/platform/overview" />
        <h1>{title}</h1>
        <p className="muted">{sub}</p>
        {children}
      </div>
    </div>
  )
}

function useSubmit(action: (values: Record<string, string>) => Promise<void>) {
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await action(Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, onSubmit }
}

export function Login() {
  const { reload } = useStaffSession()
  const navigate = useNavigate()
  const { error, busy, onSubmit } = useSubmit(async (values) => {
    const r = await api<{ setupRequired: boolean }>("POST", "/auth/login", values)
    await reload()
    navigate(r.setupRequired ? "/setup" : "/overview", { replace: true })
  })
  return (
    <Card title="Platform staff" sub="For reviewing and verifying companies.">
      <form onSubmit={onSubmit}>
        <Input name="email" label="Email" type="email" autoComplete="username" required autoFocus />
        <Input name="password" label="Password" type="password" autoComplete="current-password" required />
        <Input name="code" label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} help="Leave empty the first time you sign in" />
        <ErrorBox error={error} />
        <button className="btn primary" type="submit" disabled={busy}>{busy ? "Working…" : "Sign in"}</button>
      </form>
    </Card>
  )
}

export function Setup() {
  const { reload } = useStaffSession()
  const navigate = useNavigate()
  const toast = useToast()
  const [setup, setSetup] = useState<{ secret: string; qr: string; mustChangePassword: boolean } | null>(null)
  const [startError, setStartError] = useState<unknown>(null)
  useEffect(() => {
    api<{ secret: string; qr: string; mustChangePassword: boolean }>("POST", "/auth/setup/start", {}).then(setSetup, setStartError)
  }, [])
  const { error, busy, onSubmit } = useSubmit(async (values) => {
    await api("POST", "/auth/setup/finish", values)
    await reload()
    toast("You're set up")
    navigate("/overview", { replace: true })
  })
  return (
    <Card title="Set up sign-in" sub="Staff accounts need an authenticator app. You'll enter a code from it every time you sign in.">
      <ErrorBox error={startError} />
      {setup ? (
        <form className="stack" onSubmit={onSubmit}>
          <p>1. Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …).</p>
          <div className="qr-box"><img src={setup.qr} alt="QR code for your authenticator app" /></div>
          <details>
            <summary>Can't scan? Enter this key instead</summary>
            <div className="secret">{setup.secret}</div>
          </details>
          {setup.mustChangePassword ? (
            <Input name="newPassword" label="2. Choose a new password" type="password" required minLength={12} autoComplete="new-password" help="At least 12 characters. Replaces your temporary password." />
          ) : null}
          <Input name="code" label={`${setup.mustChangePassword ? "3" : "2"}. Enter the 6-digit code the app shows`} inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9 ]{6,7}" maxLength={7} />
          <ErrorBox error={error} />
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "Working…" : "Finish setup"}</button>
        </form>
      ) : !startError ? <p className="loading">Loading…</p> : null}
    </Card>
  )
}

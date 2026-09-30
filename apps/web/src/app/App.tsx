// URLs under /app and who may see them.
import { useState, type ReactNode } from "react"
import { Navigate, Route, Routes, useLocation } from "react-router"
import { useSession } from "./session"
import { Layout } from "./Layout"
import { ChangePassword, Login, Signup } from "./pages/Auth"
import { Documents } from "./pages/Documents"
import { NewDocument } from "./pages/NewDocument"
import { DocumentPage } from "./pages/DocumentPage"
import { Templates, TemplateChooser, TemplateRoute } from "./pages/Templates"
import { HtmlTemplateEditor } from "./pages/HtmlTemplateEditor"
import { PdfTemplateEditor } from "./pdf-editor/PdfTemplateEditor"
import { People } from "./pages/People"
import { Settings } from "./pages/Settings"
import { Activity } from "./pages/Activity"

export function App() {
  const { ready } = useSession()
  if (!ready) return <p className="loading" style={{ padding: 24 }}>Loading…</p>
  return (
    <Routes>
      <Route path="login" element={<SignedOut><Login /></SignedOut>} />
      <Route path="signup" element={<SignedOut><SignupIfAllowed /></SignedOut>} />
      <Route path="change-password" element={<SignedIn allowTemporaryPassword><ChangePassword /></SignedIn>} />
      <Route element={<SignedIn><Layout /></SignedIn>}>
        <Route index element={<Navigate to="/documents" replace />} />
        <Route path="documents" element={<Documents />} />
        <Route path="documents/new/:templateId" element={<NewDocument />} />
        <Route path="documents/:id" element={<DocumentPage />} />
        <Route path="templates" element={<Templates />} />
        <Route path="templates/add" element={<AdminOnly><TemplateChooser /></AdminOnly>} />
        <Route path="templates/new" element={<AdminOnly><HtmlTemplateEditor /></AdminOnly>} />
        <Route path="templates/new-pdf" element={<AdminOnly><PdfTemplateEditor /></AdminOnly>} />
        <Route path="templates/:id" element={<TemplateRoute />} />
        <Route path="users" element={<People />} />
        <Route path="settings" element={<Settings />} />
        <Route path="audit" element={<AdminOnly><Activity /></AdminOnly>} />
        <Route path="*" element={<Navigate to="/documents" replace />} />
      </Route>
    </Routes>
  )
}

// Signed-in screens: otherwise go to sign-in (and come back here afterwards).
function SignedIn({ children, allowTemporaryPassword = false }: { children: ReactNode; allowTemporaryPassword?: boolean }) {
  const { me } = useSession()
  const location = useLocation()
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  if (me.mustChangePassword && !allowTemporaryPassword) return <Navigate to="/change-password" replace />
  return <>{children}</>
}

// Sign-in / sign-up pages. People who arrive already signed in go to the app;
// signing in here navigates by itself (to where it should go next).
function SignedOut({ children }: { children: ReactNode }) {
  const { me } = useSession()
  const [signedInOnArrival] = useState(() => Boolean(me))
  if (signedInOnArrival && me) return <Navigate to={me.mustChangePassword ? "/change-password" : "/documents"} replace />
  return <>{children}</>
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { me } = useSession()
  if (me?.role !== "admin") return <Navigate to="/templates" replace />
  return <>{children}</>
}

function SignupIfAllowed() {
  const { config } = useSession()
  return config.allowSignup ? <Signup /> : <Navigate to="/login" replace />
}

// Entry point: routes URLs (#/documents, #/settings, …) to screens.
import { errorBox, h } from "../lib/dom.js"
import { auditScreen } from "./audit.js"
import { changePasswordScreen, loginScreen, signupScreen } from "./auth.js"
import { documentScreen, documentsScreen, newDocumentScreen } from "./documents.js"
import { pdfTemplateEditor } from "./pdf-editor.js"
import { go, setRoute } from "../lib/router.js"
import { settingsScreen } from "./settings.js"
import { shell } from "./shell.js"
import { loadMe, state } from "./state.js"
import { templateChooserScreen, templateEditorScreen, templatesScreen } from "./templates.js"
import { usersScreen } from "./users.js"

async function route() {
  window.onbeforeunload = null
  const [path, query] = (location.hash.slice(1) || "/documents").split("?")
  const params = new URLSearchParams(query || "")
  const parts = path.split("/").filter(Boolean)
  const publicRoutes = ["login", "signup"]

  if (!state.me && !publicRoutes.includes(parts[0])) return loginScreen()
  if (state.me && publicRoutes.includes(parts[0])) return go("#/documents")
  if (state.me && state.me.mustChangePassword && parts[0] !== "change-password") return go("#/change-password")

  try {
    switch (parts[0]) {
      case "login": return loginScreen()
      case "signup": return state.config.allowSignup ? signupScreen() : loginScreen()
      case "change-password": return changePasswordScreen()
      case "documents":
        if (parts[1] === "new" && parts[2]) return await newDocumentScreen(parts[2])
        if (parts[1]) return await documentScreen(parts[1])
        return await documentsScreen(params)
      case "templates":
        if (parts[1] === "add") return templateChooserScreen()
        if (parts[1] === "new-pdf") return await pdfTemplateEditor(null)
        if (parts[1]) return await templateEditorScreen(parts[1])
        return await templatesScreen()
      case "users": return await usersScreen()
      case "settings": return await settingsScreen()
      case "audit": return await auditScreen()
      default: return go("#/documents")
    }
  } catch (err) {
    if (err.status === 401) return
    shell(parts[0], h("div", { class: "card" }, errorBox(err), h("p", { style: "margin-top:12px" }, h("a", { class: "btn", href: "#/documents" }, "Back to documents"))))
  }
}

async function boot() {
  try {
    state.config = await (await fetch("/api/public/config")).json()
  } catch {}
  document.title = `${state.config.appName} — Dashboard`
  await loadMe()
  window.addEventListener("hashchange", route)
  route()
}

setRoute(route)
boot()

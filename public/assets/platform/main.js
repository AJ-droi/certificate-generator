// Entry point: routes URLs (#/overview, #/companies, …) to screens.
import { errorCode } from "../lib/api.js"
import { errorBox, h } from "../lib/dom.js"
import { go, setRoute } from "../lib/router.js"
import { activityScreen } from "./activity.js"
import { api } from "./api.js"
import { loginScreen, setupScreen } from "./auth.js"
import { companiesScreen, companyScreen, overviewScreen } from "./companies.js"
import { shell } from "./shell.js"
import { state } from "./state.js"

async function route() {
  const [path, query] = (location.hash.slice(1) || "/overview").split("?")
  const params = new URLSearchParams(query || "")
  const parts = path.split("/").filter(Boolean)
  if (!state.staff) {
    try {
      const me = await api("GET", "/auth/me")
      state.staff = me.staff
      if (me.setupRequired && parts[0] !== "setup") return go("#/setup", true)
    } catch {
      return loginScreen()
    }
  }
  try {
    switch (parts[0]) {
      case "login": return loginScreen()
      case "setup": return await setupScreen()
      case "companies": return parts[1] ? await companyScreen(parts[1]) : await companiesScreen(params)
      case "activity": return await activityScreen()
      case "overview": return await overviewScreen()
      default: return go("#/overview", true)
    }
  } catch (err) {
    if (err.status === 401 || (err.status === 403 && errorCode(err) === "setup_required")) return
    shell(parts[0] || "overview", h("div", { class: "card" }, errorBox(err), h("p", { style: "margin-top:12px" }, h("a", { class: "btn", href: "#/overview" }, "Back to overview"))))
  }
}

async function boot() {
  try {
    state.appName = (await (await fetch("/api/public/config")).json()).appName || state.appName
  } catch {}
  document.title = `${state.appName} — Platform staff`
  window.addEventListener("hashchange", route)
  route()
}

setRoute(route)
boot()

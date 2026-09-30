// Calls to the staff API (/api/platform). Sends people to sign in on 401, and
// to authenticator setup when their account still needs it.
import { createApi, errorCode } from "../lib/api.js"
import { go } from "../lib/router.js"
import { state } from "./state.js"

export const api = createApi({
  prefix: "/api/platform",
  onError(err, path) {
    if (err.status === 401 && !path.startsWith("/auth/")) {
      state.staff = null
      go("#/login", true)
    }
    if (err.status === 403 && errorCode(err) === "setup_required") go("#/setup", true)
  },
})

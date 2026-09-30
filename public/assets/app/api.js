// Calls to the company dashboard API. Signs out on 401, and sends people with a
// temporary password to choose a new one.
import { createApi, errorCode } from "../lib/api.js"
import { state } from "./state.js"
import { go } from "../lib/router.js"

export const api = createApi({
  onError(err, path) {
    if (err.status === 401 && !path.startsWith("/api/auth/")) {
      state.me = null
      go("#/login")
    }
    if (err.status === 403 && errorCode(err) === "must_change_password") go("#/change-password")
  },
})

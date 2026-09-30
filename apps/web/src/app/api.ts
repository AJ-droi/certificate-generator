// Calls to the company dashboard API. The session registers what happens on
// "signed out" (401) and "must choose a new password" (403).
import { createApi, errorCode } from "../shared/api"

const handlers = { unauthorized: () => {}, mustChangePassword: () => {} }
export const setApiHandlers = (h: typeof handlers) => Object.assign(handlers, h)

export const api = createApi({
  onError(err, path) {
    if (err.status === 401 && !path.startsWith("/api/auth/")) handlers.unauthorized()
    if (err.status === 403 && errorCode(err) === "must_change_password") handlers.mustChangePassword()
  },
})

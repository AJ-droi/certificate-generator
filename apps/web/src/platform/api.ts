// Calls to the staff API (/api/platform). The session registers what happens on
// "signed out" (401) and "authenticator app not set up yet" (403).
import { createApi, errorCode } from "../shared/api"

const handlers = { unauthorized: () => {}, setupRequired: () => {} }
export const setApiHandlers = (h: typeof handlers) => Object.assign(handlers, h)

export const api = createApi({
  prefix: "/api/platform",
  onError(err, path) {
    if (err.status === 401 && !path.startsWith("/auth/")) handlers.unauthorized()
    if (err.status === 403 && errorCode(err) === "setup_required") handlers.setupRequired()
  },
})

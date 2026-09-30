// JSON API calls. `onError(err, path)` lets each dashboard react to 401/403
// (e.g. go to the sign-in page) before the error is thrown to the caller.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Request failed (${status})`)
    this.status = status
    this.body = body || {}
  }
}

export function createApi({ prefix = "", onError } = {}) {
  return async function api(method, path, body) {
    const res = await fetch(prefix + path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null
    if (!res.ok) {
      const err = new ApiError(res.status, data)
      if (onError) onError(err, path)
      throw err
    }
    return data
  }
}

// Error details code sent by the server, e.g. "must_change_password".
export const errorCode = (err) => err && err.body && err.body.details && err.body.details.code

// JSON calls to the API. `onError` lets each dashboard react to 401/403 (e.g.
// go to the sign-in page) before the error reaches the caller.

export interface ErrorBody {
  message?: string
  requestId?: string
  details?: { code?: string; errors?: string[] }
}

export class ApiError extends Error {
  status: number
  body: ErrorBody
  constructor(status: number, body: ErrorBody | null) {
    super((body && body.message) || `Request failed (${status})`)
    this.status = status
    this.body = body || {}
  }
}

export const errorCode = (err: unknown): string | undefined => (err instanceof ApiError ? err.body.details?.code : undefined)
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>

async function parse(res: Response): Promise<unknown> {
  return res.headers.get("content-type")?.includes("json") ? res.json() : null
}

export function createApi({ prefix = "", onError }: { prefix?: string; onError?: (err: ApiError, path: string) => void } = {}): Api {
  return async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(prefix + path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await parse(res)
    if (!res.ok) {
      const err = new ApiError(res.status, data as ErrorBody | null)
      onError?.(err, path)
      throw err
    }
    return data as T
  }
}

// Sends raw PDF bytes (template form uploads).
export async function postPdf<T>(path: string, body: Blob | ArrayBuffer | Uint8Array): Promise<T> {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/pdf" }, body: body as BodyInit })
  const data = await parse(res)
  if (!res.ok) throw new ApiError(res.status, data as ErrorBody | null)
  return data as T
}

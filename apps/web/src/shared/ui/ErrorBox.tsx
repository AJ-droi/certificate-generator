import { ApiError, errorMessage } from "../api"

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  const details = error instanceof ApiError ? error.body.details?.errors : undefined
  return (
    <div className="error-box" role="alert">
      {errorMessage(error)}
      {details && (
        <ul>
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

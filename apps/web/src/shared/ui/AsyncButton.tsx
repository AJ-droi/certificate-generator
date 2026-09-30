// A button for an async action: disabled with "Working…" while it runs; errors
// go to `onError` (e.g. an error box) or a toast.
import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react"
import { errorMessage } from "../api"
import { useToast } from "./Toasts"

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "onError"> & {
  onClick: () => unknown
  onError?: (err: unknown) => void
  children: ReactNode
}

export function AsyncButton({ onClick, onError, children, className = "btn", ...rest }: Props) {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const toast = useToast()
  return (
    <button
      type="button"
      {...rest}
      className={className}
      disabled={busy || rest.disabled}
      onClick={async () => {
        if (running.current) return
        running.current = true
        setBusy(true)
        try {
          onError?.(null)
          await onClick()
        } catch (err) {
          if (onError) onError(err)
          else toast(errorMessage(err), true)
        } finally {
          running.current = false
          setBusy(false)
        }
      }}
    >
      {busy ? "Working…" : children}
    </button>
  )
}

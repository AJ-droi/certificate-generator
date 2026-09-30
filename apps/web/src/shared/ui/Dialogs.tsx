// Dialogs you can await: `const values = await dialogs.form("Title", <fields/>)`.
// Each uses the native <dialog> element (focus trapping, Escape to close).
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { ErrorBox } from "./ErrorBox"

export type FormValues = Record<string, string | boolean>
type Close<T> = (value: T | null) => void

interface Dialogs {
  // Shows any dialog; `render` gets `close(value)` which resolves the promise.
  open<T>(render: (close: Close<T>) => ReactNode): Promise<T | null>
  // A form: resolves with its named values (tick boxes as true/false), or null if cancelled.
  form(title: string, body: ReactNode, options?: FormOptions): Promise<FormValues | null>
  confirm(title: string, body: ReactNode, options?: Omit<FormOptions, "validate">): Promise<boolean>
  // Shows a secret (e.g. a temporary password) once.
  secret(title: string, text: string, secret: string): Promise<void>
}

interface FormOptions {
  submitLabel?: string
  danger?: boolean
  cancel?: boolean
  wide?: boolean
  // Throw to keep the dialog open and show the message.
  validate?: (values: FormValues) => void
}

const DialogContext = createContext<Dialogs | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Array<{ id: number; node: () => ReactNode }>>([])
  const nextId = useRef(1)

  const open = useCallback(<T,>(render: (close: Close<T>) => ReactNode) => {
    return new Promise<T | null>((resolve) => {
      const id = nextId.current++
      let done = false
      const close: Close<T> = (value) => {
        if (done) return
        done = true
        setEntries((list) => list.filter((e) => e.id !== id))
        resolve(value)
      }
      setEntries((list) => [...list, { id, node: () => render(close) }])
    })
  }, [])

  const dialogs = useMemo<Dialogs>(() => {
    const form = (title: string, body: ReactNode, options: FormOptions = {}) =>
      open<FormValues>((close) => <FormDialog title={title} options={options} onClose={close}>{body}</FormDialog>)
    return {
      open,
      form,
      confirm: async (title, body, options = {}) => (await form(title, body, options)) !== null,
      secret: async (title, text, secret) => {
        await form(title, <><p>{text}</p><div className="secret">{secret}</div></>, { submitLabel: "Done", cancel: false })
      },
    }
  }, [open])

  return (
    <DialogContext.Provider value={dialogs}>
      {children}
      {entries.map((e) => (
        <Fragment key={e.id}>{e.node()}</Fragment>
      ))}
    </DialogContext.Provider>
  )
}

export function useDialogs(): Dialogs {
  const d = useContext(DialogContext)
  if (!d) throw new Error("useDialogs needs <DialogProvider>")
  return d
}

// The <dialog> element, opened as a modal while mounted. Escape calls onCancel.
export function Modal({ onCancel, wide, children }: { onCancel: () => void; wide?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancel = useRef(onCancel)
  useEffect(() => {
    cancel.current = onCancel
  })
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) d.showModal()
    const onEscape = (e: Event) => {
      e.preventDefault()
      cancel.current()
    }
    d.addEventListener("cancel", onEscape)
    return () => d.removeEventListener("cancel", onEscape)
  }, [])
  return (
    <dialog ref={ref} className={wide ? "wide" : undefined}>
      {children}
    </dialog>
  )
}

function FormDialog({ title, options, onClose, children }: { title: string; options: FormOptions; onClose: Close<FormValues>; children: ReactNode }) {
  const { submitLabel = "OK", danger = false, cancel = true, wide = false, validate } = options
  const [error, setError] = useState<unknown>(null)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const values: FormValues = {}
    for (const el of Array.from(e.currentTarget.elements) as HTMLInputElement[]) {
      if (!el.name) continue
      if (el.type === "radio") {
        if (el.checked) values[el.name] = el.value
      } else {
        values[el.name] = el.type === "checkbox" ? el.checked : el.value
      }
    }
    try {
      validate?.(values)
    } catch (err) {
      setError(err)
      return
    }
    onClose(values)
  }
  return (
    <Modal onCancel={() => onClose(null)} wide={wide}>
      <form method="dialog" onSubmit={submit}>
        <h2>{title}</h2>
        {children}
        <ErrorBox error={error} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {cancel && (
            <button className="btn" type="button" onClick={() => onClose(null)}>
              Cancel
            </button>
          )}
          <button className={`btn ${danger ? "danger" : "primary"}`} type="submit">
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// Short messages in the corner ("Saved", or an error in red).
import { createContext, useCallback, useContext, useState, type ReactNode } from "react"

type Toast = (message: string, bad?: boolean) => void
const ToastContext = createContext<Toast>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Array<{ id: number; message: string; bad: boolean }>>([])
  const toast = useCallback<Toast>((message, bad = false) => {
    const id = Date.now() + Math.random()
    setItems((list) => [...list, { id, message, bad }])
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), bad ? 6000 : 3000)
  }, [])
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-host" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.bad ? " bad" : ""}`} role="status">
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

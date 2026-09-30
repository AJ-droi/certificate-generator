import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "@doctrust/shared/styles/site.css"
import { ToastProvider } from "../shared/ui/Toasts"
import { DialogProvider } from "../shared/ui/Dialogs"
import { SessionProvider } from "./session"
import { App } from "./App"

// Links from before the React version used #/documents/…: keep them working.
if (location.hash.startsWith("#/")) history.replaceState(null, "", `/app${location.hash.slice(1)}`)

const queries = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <QueryClientProvider client={queries}>
        <ToastProvider>
          <DialogProvider>
            <SessionProvider>
              <App />
            </SessionProvider>
          </DialogProvider>
        </ToastProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
)

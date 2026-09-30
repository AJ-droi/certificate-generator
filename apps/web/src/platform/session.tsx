// The signed-in staff member, loaded with React Query ("staff").
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { PublicConfig, Staff } from "@doctrust/shared"
import { ApiError } from "../shared/api"
import { api, setApiHandlers } from "./api"

interface StaffSession {
  appName: string
  staff: Staff | null
  setupRequired: boolean
  ready: boolean
  reload(): Promise<void>
  signOut(): Promise<void>
}

const Ctx = createContext<StaffSession | null>(null)

async function fetchStaff(): Promise<{ staff: Staff; setupRequired: boolean } | null> {
  try {
    return await api<{ staff: Staff; setupRequired: boolean }>("GET", "/auth/me")
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const queries = useQueryClient()
  const staffQuery = useQuery({ queryKey: ["staff"], queryFn: fetchStaff, staleTime: Infinity })
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: async () => (await (await fetch("/api/public/config")).json()) as PublicConfig,
    staleTime: Infinity,
  })
  const appName = configQuery.data?.appName || "DocTrust"

  const reload = useCallback(async () => {
    await queries.invalidateQueries({ queryKey: ["staff"] })
  }, [queries])

  const signedOut = useCallback(() => {
    queries.removeQueries({ predicate: (q) => !["staff", "config"].includes(String(q.queryKey[0])) })
    queries.setQueryData(["staff"], null)
  }, [queries])

  const signOut = useCallback(async () => {
    await api("POST", "/auth/logout", {}).catch(() => {})
    signedOut()
    navigate("/login")
  }, [navigate, signedOut])

  useEffect(() => {
    setApiHandlers({
      unauthorized: () => {
        signedOut()
        navigate("/login")
      },
      setupRequired: () => navigate("/setup"),
    })
  }, [navigate, signedOut])

  useEffect(() => {
    document.title = `${appName} — Platform staff`
  }, [appName])

  const data = staffQuery.data ?? null
  const value = useMemo<StaffSession>(
    () => ({ appName, staff: data?.staff ?? null, setupRequired: Boolean(data?.setupRequired), ready: staffQuery.status !== "pending", reload, signOut }),
    [appName, data, staffQuery.status, reload, signOut],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStaffSession(): StaffSession {
  const s = useContext(Ctx)
  if (!s) throw new Error("useStaffSession needs <StaffSessionProvider>")
  return s
}

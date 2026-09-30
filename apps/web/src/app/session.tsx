// Who is signed in, their company, and the app settings — for every screen.
// Loaded with React Query ("me" and "config"); `reload()` fetches them again.
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { Me, Organization, PublicConfig, User } from "@doctrust/shared"
import { ApiError } from "../shared/api"
import { api, setApiHandlers } from "./api"

interface Session {
  config: PublicConfig
  me: User | null
  org: Organization | null
  ready: boolean
  reload(): Promise<void>
  signOut(): Promise<void>
}

const SessionContext = createContext<Session | null>(null)
const DEFAULT_CONFIG: PublicConfig = { appName: "DocTrust", allowSignup: true }

// null when signed out (not an error).
async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("GET", "/api/auth/me")
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const queries = useQueryClient()
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe, staleTime: Infinity })
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: async () => (await (await fetch("/api/public/config")).json()) as PublicConfig,
    staleTime: Infinity,
  })
  const config = configQuery.data ?? DEFAULT_CONFIG

  const reload = useCallback(async () => {
    await queries.invalidateQueries({ queryKey: ["me"] })
  }, [queries])

  // Forget everything cached for the previous person.
  const signedOut = useCallback(() => {
    queries.removeQueries({ predicate: (q) => !["me", "config"].includes(String(q.queryKey[0])) })
    queries.setQueryData(["me"], null)
  }, [queries])

  const signOut = useCallback(async () => {
    await api("POST", "/api/auth/logout", {}).catch(() => {})
    signedOut()
    navigate("/login")
  }, [navigate, signedOut])

  useEffect(() => {
    setApiHandlers({
      unauthorized: () => {
        signedOut()
        navigate("/login")
      },
      mustChangePassword: () => navigate("/change-password"),
    })
  }, [navigate, signedOut])

  useEffect(() => {
    document.title = `${config.appName} — Dashboard`
  }, [config.appName])

  const me = meQuery.data ?? null
  const value = useMemo<Session>(
    () => ({ config, me: me?.user ?? null, org: me?.organization ?? null, ready: meQuery.status !== "pending", reload, signOut }),
    [config, me, meQuery.status, reload, signOut],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error("useSession needs <SessionProvider>")
  return s
}

// The signed-in person and company (inside the signed-in part of the app).
export function useMe() {
  const { me, org, config, reload } = useSession()
  if (!me || !org) throw new Error("Not signed in")
  return {
    me,
    org,
    config,
    reload,
    isAdmin: me.role === "admin",
    canApprove: me.role === "admin" || me.role === "approver",
    orgVerified: org.verification?.status === "verified",
  }
}

export const NOT_VERIFIED_TITLE = "Your company must be verified before documents can be issued"

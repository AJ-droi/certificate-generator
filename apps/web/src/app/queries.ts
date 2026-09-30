// Data every few screens need, cached by React Query.
import { useQuery } from "@tanstack/react-query"
import type { Template } from "@doctrust/shared"
import { api } from "./api"

export const useTemplates = () =>
  useQuery({ queryKey: ["templates"], queryFn: async () => (await api<{ templates: Template[] }>("GET", "/api/templates")).templates })

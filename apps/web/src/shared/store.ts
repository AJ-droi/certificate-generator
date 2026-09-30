// A small store for the template editors. Their model (fields, boxes, tables)
// is one big object edited from many places; `edit(draft => …)` changes it in
// place and redraws every component using it — like Immer, but without copying
// the whole layout on every mouse move while dragging a box.
import { useSyncExternalStore } from "react"

export interface Store<T> {
  get(): T
  // `quiet`: change without redrawing (e.g. while dragging; redraw on release).
  edit(fn: (draft: T) => void, options?: { quiet?: boolean }): void
  subscribe(listener: () => void): () => void
  version(): number
}

export function createStore<T>(model: T): Store<T> {
  let version = 0
  const listeners = new Set<() => void>()
  return {
    get: () => model,
    edit(fn, options) {
      fn(model)
      if (options?.quiet) return
      version++
      listeners.forEach((l) => l())
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => version,
  }
}

// Reads the model and redraws the component after every (non-quiet) edit.
export function useStore<T>(store: Store<T>): T {
  useSyncExternalStore(store.subscribe, store.version)
  return store.get()
}

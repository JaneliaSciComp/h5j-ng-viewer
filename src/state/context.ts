// The contexts the store publishes, and the hooks components read them through.
//
// Separate from store.tsx because a module that exports a component must export
// *only* components for React Fast Refresh to work (eslint enforces this, and the
// repo treats warnings as errors). So the Provider lives next door and everything
// non-component lives here.

import { createContext, useContext } from "react"
import type { AppState } from "@/state/reducer"
import type { Dispatch } from "@/state/actions"

export const StateContext = createContext<AppState | null>(null)
export const DispatchContext = createContext<Dispatch | null>(null)

export function useAppState(): AppState {
  const state = useContext(StateContext)
  if (!state) throw new Error("useAppState must be used inside <StoreProvider>")
  return state
}

export function useDispatch(): Dispatch {
  const dispatch = useContext(DispatchContext)
  if (!dispatch)
    throw new Error("useDispatch must be used inside <StoreProvider>")
  return dispatch
}

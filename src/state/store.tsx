// The store: `useReducer` plus context, with the file layout and action-constant
// convention a Clio developer would recognize, but without redux/react-redux for a
// single-slice, single-screen app. Swapping in Redux Toolkit later is mechanical --
// the reducer and action creators would move across unchanged.
//
// This file exports only the Provider; the contexts and the hooks that read them are
// in context.ts, so React Fast Refresh keeps working.

import { useMemo, useReducer } from "react"
import type { ReactElement, ReactNode } from "react"
import { initialState, reducer } from "@/state/reducer"
import { DispatchContext, StateContext } from "@/state/context"
import type { Action, Dispatch } from "@/state/actions"

export function StoreProvider(props: { children: ReactNode }): ReactElement {
  const [state, dispatch] = useReducer(reducer, initialState)

  // `dispatch` from useReducer is already stable, but wrapping it keeps the context
  // value typed as our own Dispatch rather than React's, so nothing outside this file
  // needs to know which state library is underneath.
  const dispatchAction = useMemo<Dispatch>(
    () => (action: Action) => dispatch(action),
    []
  )

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatchAction}>
        {props.children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  )
}

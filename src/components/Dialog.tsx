import { useEffect, useRef } from "react"
import type { ReactElement, ReactNode } from "react"

/**
 * Thin wrapper over the native `<dialog>` element, which already provides the modal
 * behavior worth having: a backdrop, focus trapping, inert background content and
 * Esc-to-dismiss. Driving it from `open` means the only custom logic is keeping the
 * DOM's own open state in step with React's.
 */
export function Dialog(props: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (props.open && !element.open) element.showModal()
    else if (!props.open && element.open) element.close()
  }, [props.open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      // Fires for Esc and for form-method=dialog buttons as well as our own close
      // call, so this is the single place that reports dismissal upwards.
      onClose={props.onClose}
      // The backdrop is part of the dialog's own box, so a click lands on the dialog
      // itself only when it is outside the inner panel.
      onClick={(event) => {
        if (event.target === ref.current) props.onClose()
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-panel">
        <header className="dialog-header">
          <h2 id="dialog-title">{props.title}</h2>
          <button
            type="button"
            onClick={props.onClose}
            title="Close"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </header>
        <div className="dialog-body">{props.children}</div>
      </div>
    </dialog>
  )
}

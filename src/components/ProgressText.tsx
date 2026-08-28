import type { ReactElement } from "react"
import type { Phase } from "@/state/actions"

/**
 * The conversion readout: a percentage while a channel is being converted, nothing at
 * all when everything is loaded. A percentage rather than a bar, because a bar wide
 * enough to read would cost more of a 32px bar than it earns -- and the converting
 * chip already carries the same number as a ring, so this text never has to say which
 * channel it belongs to.
 *
 * Errors and warnings take the same slot, since they are mutually exclusive with
 * progress in practice and neither deserves permanent width.
 */

const PHASE_LABELS: Record<Phase, string> = {
  idle: "",
  fetching: "Loading file",
  decoding: "Decoding",
  chunking: "Chunking",
  downsampling: "Downsampling",
  writing: "Writing",
  done: "",
}

export function ProgressText(props: {
  phase: Phase
  /** 0..1, or null when the phase has no meaningful fraction. */
  fraction: number | null
  warnings: string[]
  error: string | null
  /** Opens the place where the full text lives. */
  onShowDetails: () => void
}): ReactElement | null {
  const busy = props.phase !== "idle" && props.phase !== "done"

  if (props.error) {
    return (
      <button
        type="button"
        className="bar-alert"
        title={props.error}
        onClick={props.onShowDetails}
      >
        ⚠ {props.error}
      </button>
    )
  }

  if (busy) {
    const percent =
      props.fraction === null ? "" : ` ${Math.round(props.fraction * 100)}%`
    return (
      <span className="bar-progress" aria-live="polite">
        {PHASE_LABELS[props.phase]}
        {percent}
      </span>
    )
  }

  if (props.warnings.length > 0) {
    return (
      <button
        type="button"
        className="bar-alert"
        title={props.warnings.join("\n")}
        onClick={props.onShowDetails}
      >
        ⚠ {props.warnings.length}
      </button>
    )
  }

  return null
}

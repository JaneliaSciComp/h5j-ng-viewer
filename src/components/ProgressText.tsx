import type { ReactElement } from "react"
import type { Phase } from "@/state/actions"

/**
 * The readout for work that belongs to no single channel -- fetching the container,
 * decoding, reclaiming space -- plus errors and warnings. Per-channel conversion has its
 * own progress bar under each channel's controls, so this stays quiet while a specific
 * channel is converting and only speaks for the phases that precede one.
 *
 * Errors and warnings share the slot, since they are mutually exclusive with progress in
 * practice and neither deserves permanent width in a 32px bar.
 */

const PHASE_LABELS: Record<Phase, string> = {
  idle: "",
  evicting: "Reclaiming space",
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
  /**
   * What the phase is working on, e.g. "Level 2 of 4" or "3 volumes, 4.1 GB". The
   * reducer has always recorded this and nothing rendered it, so the two phases that
   * take longest were the two that said least about what they were doing.
   */
  detail?: string
  /**
   * Which channel is converting right now, or null between channels. When a channel owns
   * the work, its own progress bar shows it and this readout stays silent -- so the global
   * percentage only appears for the phases that run before any channel does.
   */
  channelIndex: number | null
  warnings: string[]
  error: string | null
  /** Opens the place where the full text lives. */
  onShowDetails: () => void
}): ReactElement | null {
  const busy =
    props.phase !== "idle" &&
    props.phase !== "done" &&
    props.channelIndex === null

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
        {props.detail ? ` — ${props.detail}` : ""}
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

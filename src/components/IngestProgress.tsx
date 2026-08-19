import { useId } from "react"
import type { ReactElement } from "react"
import type { IngestPhase } from "@/types"

type Phase = IngestPhase | "decoding" | "idle"

const PHASE_LABELS: Record<Phase, string> = {
  idle: "Idle",
  decoding: "Decoding H.265",
  chunking: "Chunking",
  downsampling: "Building pyramid",
  writing: "Writing chunks",
  done: "Ready",
}

/** Idle and done are resting states; a progress bar there reads as stalled work. */
const isActive = (phase: Phase) => phase !== "idle" && phase !== "done"

export function IngestProgress(props: {
  phase: Phase
  /** 0..1, or null when the phase has no meaningful fraction. */
  fraction: number | null
  /** e.g. "Channel_0 (1 of 3)" */
  channelLabel?: string
  detail?: string
  warnings?: string[]
  error?: string | null
  /** Single-line variant for the top bar. */
  compact?: boolean
}): ReactElement {
  const progressId = useId()
  const label = PHASE_LABELS[props.phase]
  const heading = `${label}${props.channelLabel ? ` — ${props.channelLabel}` : ""}`
  const active = isActive(props.phase)

  const bar = active ? (
    props.fraction !== null ? (
      <progress
        id={progressId}
        aria-label={heading}
        value={props.fraction}
        max={1}
      />
    ) : (
      <progress id={progressId} aria-label={heading} />
    )
  ) : null

  if (props.compact) {
    return (
      <div className="ingest-progress ingest-compact" aria-live="polite">
        <span className="ingest-label">{heading}</span>
        {bar}
        {props.detail ? (
          <span className="ingest-detail">{props.detail}</span>
        ) : null}
        {props.warnings && props.warnings.length > 0 ? (
          // Collapsed to a count with the full text in the tooltip, because a warning
          // list would push the viewer down and these are advisory.
          <span className="ingest-warnings" title={props.warnings.join("\n")}>
            {props.warnings.length} warning
            {props.warnings.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {props.error ? (
          <span className="ingest-error" role="alert" title={props.error}>
            {props.error}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="ingest-progress">
      <div className="ingest-status" aria-live="polite">
        <label htmlFor={progressId}>{heading}</label>
        {bar}
        {props.detail ? <p className="ingest-detail">{props.detail}</p> : null}
      </div>
      {props.warnings && props.warnings.length > 0 ? (
        <ul className="ingest-warnings">
          {props.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {props.error ? (
        <p className="ingest-error" role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  )
}

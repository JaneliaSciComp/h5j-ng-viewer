import { useId } from "react"
import type { ReactElement } from "react"
import type { IngestPhase } from "@/types"

const PHASE_LABELS: Record<IngestPhase | "decoding" | "idle", string> = {
  idle: "Idle",
  decoding: "Decoding H.265",
  chunking: "Chunking",
  downsampling: "Building pyramid",
  writing: "Writing chunks",
  done: "Ready",
}

export function IngestProgress(props: {
  phase: IngestPhase | "decoding" | "idle"
  /** 0..1, or null when the phase has no meaningful fraction. */
  fraction: number | null
  /** e.g. "Channel_0 (1 of 3)" */
  channelLabel?: string
  detail?: string
  warnings?: string[]
  error?: string | null
}): ReactElement {
  const progressId = useId()
  const label = PHASE_LABELS[props.phase]

  return (
    <div className="ingest-progress">
      <div className="ingest-status" aria-live="polite">
        <label htmlFor={progressId}>
          {label}
          {props.channelLabel ? ` — ${props.channelLabel}` : ""}
        </label>
        {props.fraction !== null ? (
          <progress id={progressId} value={props.fraction} max={1} />
        ) : (
          <progress id={progressId} />
        )}
        {props.detail ? <p className="ingest-detail">{props.detail}</p> : null}
      </div>
      {props.warnings && props.warnings.length > 0 ? (
        <ul className="ingest-warnings">
          {props.warnings.map((w, i) => (
            <li key={i}>{w}</li>
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

import type { ReactElement } from "react"

export function StorageStatus(props: {
  usage: number
  quota: number
  /** Projected bytes for the pending ingest, or null when nothing is pending. */
  projected: number | null
  persisted: boolean
  onClear: () => void
  clearing?: boolean
}): ReactElement {
  const remaining = props.quota - props.usage
  const overQuota = props.projected !== null && props.projected > remaining

  return (
    <div className="storage-status">
      <p>
        Storage: {formatBytes(props.usage)} / {formatBytes(props.quota)} used
        {props.persisted ? "" : " (not persisted)"}
      </p>
      {props.projected !== null ? (
        <p
          className={overQuota ? "storage-warning" : undefined}
          role={overQuota ? "alert" : undefined}
        >
          Projected ingest size: {formatBytes(props.projected)}
          {overQuota ? " — exceeds remaining quota, ingest may fail" : ""}
        </p>
      ) : null}
      <button type="button" onClick={props.onClear} disabled={props.clearing}>
        {props.clearing ? "Clearing…" : "Clear cached data"}
      </button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exp
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`
}

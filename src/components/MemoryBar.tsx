import type { ReactElement } from "react"
import { formatBytes, usedFraction } from "@/lib/bytes"
import { EXPIRY_DAYS, QUOTA_SAFETY_SHARE } from "@/lib/prefs"
import type { StorageLimit } from "@/lib/prefs"

/**
 * How much of its storage limit the app is using, in the bar rather than behind the gear.
 *
 * It belongs here because of the ratio: an 11 MB H5J becomes roughly 1.3 GB of
 * pre-chunked, uncompressed volume, so a few files fill the limit. Behind a dialog that
 * figure is something you have to remember to go and check, and the moment it matters --
 * while a conversion is filling the disk -- is exactly the moment you are watching the
 * viewer instead.
 *
 * Measured against the storage limit, not the browser's quota. The limit is the number
 * the user set and can reason about; against a quota of hundreds of gigabytes, a full
 * 20 GB limit would read as an almost empty bar.
 *
 * "Memory" is the user's word for it. The tooltip says storage, since this is disk
 * rather than RAM and the difference matters if anyone acts on it.
 */
export function MemoryBar(props: {
  usage: number
  quota: number
  /** Projected size of the conversion in flight, or null when nothing is pending. */
  projected: number | null
  /** Whether the browser has promised not to clear this data under disk pressure. */
  persisted: boolean
  /** The limit in force, and which rule set it. */
  limit: StorageLimit
}): ReactElement {
  // No figure until the estimate resolves: an empty bar would claim there is room, and
  // on first paint we do not know that yet.
  const fraction =
    props.quota > 0 ? usedFraction(props.usage, props.limit.bytes) : null
  // Past the limit, older volumes are discarded to make room -- worth a warning color
  // even though nothing has failed.
  const over =
    props.projected !== null &&
    props.usage + props.projected > props.limit.bytes

  // Drawn as a second segment starting where the used one ends, so the question the bar
  // answers is "will this fit" rather than "how full is it now" -- which is the question
  // actually being asked while a conversion runs.
  const projectedFraction =
    props.projected !== null && props.limit.bytes > 0
      ? Math.min(1 - (fraction ?? 0), props.projected / props.limit.bytes)
      : 0

  const description = describe(props)

  return (
    <span className="bar-memory" title={description}>
      <span className="bar-memory-label">Memory</span>
      <span
        className={over ? "bar-memory-track over" : "bar-memory-track"}
        role="progressbar"
        aria-label="Storage used, against the storage limit"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          fraction === null ? undefined : Math.round(fraction * 100)
        }
        aria-valuetext={description}
      >
        <span
          className="bar-memory-used"
          style={{ width: `${(fraction ?? 0) * 100}%` }}
        />
        <span
          className="bar-memory-projected"
          style={{ width: `${projectedFraction * 100}%` }}
        />
      </span>
      <span className="bar-memory-value">
        {fraction === null ? "—" : `${Math.round(fraction * 100)}%`}
      </span>
    </span>
  )
}

function describe(props: {
  usage: number
  quota: number
  projected: number | null
  persisted: boolean
  limit: StorageLimit
}): string {
  if (props.quota <= 0) return "Storage — measuring…"
  const { usage, quota, projected, persisted, limit } = props

  const lines = [
    `Storage: ${formatBytes(usage)} of a ${formatBytes(limit.bytes)} limit ` +
      `(${formatBytes(Math.max(0, limit.bytes - usage))} left)`,
    limit.reason === "quota"
      ? `Limited to ${formatBytes(limit.bytes)} because disk space is low: this app ` +
        `never uses more than ${Math.round(QUOTA_SAFETY_SHARE * 100)}% of the browser's ` +
        `quota (${formatBytes(quota)}), which shrinks as the disk fills.`
      : "The limit is set in Settings.",
  ]
  if (projected !== null) {
    lines.push(
      usage + projected > limit.bytes
        ? `This conversion needs about ${formatBytes(projected)} — older volumes ` +
            `will be discarded to make room`
        : `This conversion needs about ${formatBytes(projected)}`
    )
  }
  lines.push(
    `Past the limit the least recently opened volumes are discarded, and volumes not ` +
      `opened for ${EXPIRY_DAYS} days are removed when the app starts.`
  )
  lines.push(
    persisted
      ? "Persisted: the browser will not clear this data even when the disk is low."
      : "Not persisted: the browser may clear this data if the disk gets low."
  )
  return lines.join("\n")
}

import type { CSSProperties, ReactElement } from "react"
import { formatBytes, usedFraction } from "@/lib/bytes"
import { clampEvictionPercent, storageBudget } from "@/lib/prefs"

/**
 * How full the browser's storage is, in the bar rather than behind the gear.
 *
 * It belongs here because of the ratio: an 11 MB H5J becomes roughly 1.3 GB of
 * pre-chunked, uncompressed volume, so a few files can exhaust a quota. Behind a dialog
 * that figure is something you have to remember to go and check, and the moment it
 * matters -- while a conversion is filling the disk -- is exactly the moment you are
 * watching the viewer instead.
 *
 * "Memory" is the user's word for it. The tooltip says storage, since this is disk
 * rather than RAM and the difference matters if anyone acts on it.
 */
export function MemoryBar(props: {
  usage: number
  quota: number
  /** Projected size of the conversion in flight, or null when nothing is pending. */
  projected: number | null
  /** Whether the browser has promised not to evict this data under pressure. */
  persisted: boolean
  /** Share of the quota this app will use before discarding old volumes. */
  evictionPercent: number
}): ReactElement {
  const fraction = usedFraction(props.usage, props.quota)
  const remaining = props.quota - props.usage
  const overQuota = props.projected !== null && props.projected > remaining

  // Drawn as a second segment starting where the used one ends, so the question the bar
  // answers is "will this fit" rather than "how full is it now" -- which is the question
  // actually being asked while a conversion runs.
  const projectedFraction =
    props.projected !== null && props.quota > 0
      ? Math.min(1 - (fraction ?? 0), props.projected / props.quota)
      : 0

  return (
    <span
      className="bar-memory"
      title={describe(
        props.usage,
        props.quota,
        props.projected,
        props.persisted,
        props.evictionPercent
      )}
    >
      <span className="bar-memory-label">Memory</span>
      <span
        className={overQuota ? "bar-memory-track over" : "bar-memory-track"}
        // Where eviction begins. Drawn on the track rather than only stated in
        // Settings, so the number someone set is visible against the fill it governs.
        style={
          {
            "--eviction-mark": `${clampEvictionPercent(props.evictionPercent)}%`,
          } as CSSProperties
        }
        role="progressbar"
        aria-label="Browser storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          fraction === null ? undefined : Math.round(fraction * 100)
        }
        aria-valuetext={describe(
          props.usage,
          props.quota,
          props.projected,
          props.persisted,
          props.evictionPercent
        )}
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
      {/* An em dash rather than "0%" until the estimate resolves: an empty bar would
          claim there is room, and on first paint we do not know that yet. */}
      <span className="bar-memory-value">
        {fraction === null ? "—" : `${Math.round(fraction * 100)}%`}
      </span>
    </span>
  )
}

function describe(
  usage: number,
  quota: number,
  projected: number | null,
  persisted: boolean,
  evictionPercent: number
): string {
  if (quota <= 0) return "Browser storage — measuring…"

  const lines = [
    `Browser storage: ${formatBytes(usage)} of ${formatBytes(quota)} used ` +
      `(${formatBytes(quota - usage)} free)`,
  ]
  if (projected !== null) {
    lines.push(
      projected > quota - usage
        ? `This conversion needs about ${formatBytes(projected)} — more than the space left`
        : `This conversion needs about ${formatBytes(projected)}`
    )
  }
  lines.push(
    persisted
      ? "Persisted: the browser will not evict this data to reclaim space."
      : "Not persisted: the browser may evict this data under storage pressure."
  )
  lines.push(
    `Past ${clampEvictionPercent(evictionPercent)}% ` +
      `(${formatBytes(storageBudget(quota, evictionPercent))}) the least recently ` +
      `used volumes are discarded. Change that, or clear everything, in Settings.`
  )
  return lines.join("\n")
}

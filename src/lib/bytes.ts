// Byte sizes, formatted the same way everywhere they are shown. Shared rather than
// duplicated because the top bar and the settings dialog display the same figures, and
// two of these drifting apart would read as a bug in the measurement rather than in the
// formatting.

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/**
 * A byte count at human scale: "0 B", "512 KB", "1.3 GB".
 *
 * Binary units, because that is what `navigator.storage.estimate()` reports against.
 * Whole bytes below a kilobyte -- "0.5 KB" is worse than "512 B" -- and one decimal
 * above, which is as much precision as a quota figure deserves.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    UNITS.length - 1
  )
  const value = bytes / 1024 ** exp
  return `${exp === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[exp]}`
}

/**
 * Fraction of the quota in use, clamped to 0..1.
 *
 * Returns null when there is no quota to be a fraction of. That is the state on first
 * paint, before `navigator.storage.estimate()` resolves, and it has to be distinguishable
 * from "0% used" -- an empty bar claims the browser has room, which is a claim we cannot
 * make yet.
 */
export function usedFraction(usage: number, quota: number): number | null {
  if (!Number.isFinite(quota) || quota <= 0) return null
  return Math.min(1, Math.max(0, usage / quota))
}

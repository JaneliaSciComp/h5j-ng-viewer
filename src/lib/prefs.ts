// Preferences that outlive a session.
//
// Small enough not to want a store of its own, but it does have to survive a reload:
// a storage ceiling that reset every time the tab opened would be no ceiling at all.

const STORAGE_KEY = "h5j-ng-viewer.evictionPercent"

/**
 * How full storage is allowed to get before old volumes start being discarded, as a
 * percentage of the browser's quota.
 *
 * Below 100 on purpose. The quota is a share of one disk that every other site is also
 * drawing on, and a viewer that fills its entire allowance is a bad neighbour even when
 * the browser lets it. Leaving headroom also means a conversion that turns out larger
 * than projected has somewhere to go instead of failing at the last chunk.
 */
export const DEFAULT_EVICTION_PERCENT = 80

/** Wide bounds: the low end is for deliberately provoking eviction while testing. */
export const EVICTION_PERCENT_MIN = 5
export const EVICTION_PERCENT_MAX = 100

export function clampEvictionPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EVICTION_PERCENT
  return Math.min(
    EVICTION_PERCENT_MAX,
    Math.max(EVICTION_PERCENT_MIN, Math.round(value))
  )
}

/**
 * The share of `quota` this app will use, in bytes. Everything above it is headroom
 * left for other sites and for a conversion that runs over its projection.
 */
export function storageBudget(quota: number, percent: number): number {
  if (!Number.isFinite(quota) || quota <= 0) return 0
  return (quota * clampEvictionPercent(percent)) / 100
}

/** Never throws: storage can be unavailable, and a missing preference is not an error. */
export function loadEvictionPercent(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null
      ? DEFAULT_EVICTION_PERCENT
      : clampEvictionPercent(Number(raw))
  } catch {
    return DEFAULT_EVICTION_PERCENT
  }
}

export function saveEvictionPercent(percent: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampEvictionPercent(percent)))
  } catch {
    // Private browsing, or storage disabled. The setting simply will not persist.
  }
}

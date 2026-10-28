// Preferences that outlive a session, and the storage limit derived from them.
//
// Small enough not to want a store of its own, but it does have to survive a reload:
// a storage ceiling that reset every time the tab opened would be no ceiling at all.

const LIMIT_KEY = "h5j-ng-viewer.storageLimitGb"
const KEEP_KEY = "h5j-ng-viewer.keepWhenDiskLow"

/** Binary, to match `formatBytes` and `navigator.storage.estimate()`. */
export const GB = 1024 ** 3

/**
 * How much converted data the app keeps, in gigabytes, unless the user says otherwise.
 *
 * Gigabytes rather than a share of the browser's quota, because that is how a person
 * thinks about their disk: "how much will I give this app". The quota is a figure they
 * never see, it moves as the disk fills, and each origin the app runs on has its own --
 * so "80% of the quota" was both unreadable and, on a large disk, about half the disk.
 */
export const DEFAULT_STORAGE_LIMIT_GB = 20
export const STORAGE_LIMIT_GB_MIN = 1
export const STORAGE_LIMIT_GB_MAX = 10000

/**
 * Never more than this share of the browser's quota, whatever the user's cap says.
 *
 * Not a setting. The quota is worked out from the disk, so it shrinks as the disk fills;
 * holding the app under half of it is what keeps a fixed cap from filling a nearly full
 * disk. On a roomy disk the user's cap is the smaller and this never shows.
 */
export const QUOTA_SAFETY_SHARE = 0.5

/** A converted volume not opened for this long is discarded at the next startup. */
export const EXPIRY_DAYS = 14
export const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000

export function clampStorageLimitGb(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STORAGE_LIMIT_GB
  return Math.min(
    STORAGE_LIMIT_GB_MAX,
    Math.max(STORAGE_LIMIT_GB_MIN, Math.round(value))
  )
}

export interface StorageLimit {
  /** The most converted data the app will keep, in bytes. */
  bytes: number
  /**
   * Which rule set it: the user's cap, or the quota safety share. When it is the quota,
   * the UI says so -- otherwise a limit lower than the one the user typed looks like a
   * bug.
   */
  reason: "cap" | "quota"
}

/**
 * The limit in force: the user's cap, or half the browser's quota if that is smaller.
 * With no quota to go on (before the estimate resolves, or a browser that reports none),
 * the cap alone -- it is known without asking the browser anything.
 */
export function storageLimit(quota: number, limitGb: number): StorageLimit {
  const cap = clampStorageLimitGb(limitGb) * GB
  if (!Number.isFinite(quota) || quota <= 0) return { bytes: cap, reason: "cap" }
  const safety = quota * QUOTA_SAFETY_SHARE
  return safety < cap
    ? { bytes: safety, reason: "quota" }
    : { bytes: cap, reason: "cap" }
}

/** Never throws: storage can be unavailable, and a missing preference is not an error. */
export function loadStorageLimitGb(): number {
  try {
    const raw = localStorage.getItem(LIMIT_KEY)
    return raw === null ? DEFAULT_STORAGE_LIMIT_GB : clampStorageLimitGb(Number(raw))
  } catch {
    return DEFAULT_STORAGE_LIMIT_GB
  }
}

export function saveStorageLimitGb(limitGb: number): void {
  try {
    localStorage.setItem(LIMIT_KEY, String(clampStorageLimitGb(limitGb)))
  } catch {
    // Private browsing, or storage disabled. The setting simply will not persist.
  }
}

/**
 * Whether the user has asked to keep converted volumes even when the disk is low, i.e.
 * to request persistent storage. Off by default: persisted data is exempt from the
 * browser's own cleanup under disk pressure, and that cleanup is the only thing that
 * ever clears an origin the app is no longer opened on.
 */
export function loadKeepWhenDiskLow(): boolean {
  try {
    return localStorage.getItem(KEEP_KEY) === "true"
  } catch {
    return false
  }
}

export function saveKeepWhenDiskLow(keep: boolean): void {
  try {
    localStorage.setItem(KEEP_KEY, String(keep))
  } catch {
    // As above.
  }
}

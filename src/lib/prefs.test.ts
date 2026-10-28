import { describe, expect, it } from "vitest"
import {
  clampStorageLimitGb,
  DEFAULT_STORAGE_LIMIT_GB,
  GB,
  QUOTA_SAFETY_SHARE,
  STORAGE_LIMIT_GB_MAX,
  STORAGE_LIMIT_GB_MIN,
  storageLimit,
} from "@/lib/prefs"

describe("clampStorageLimitGb", () => {
  it("keeps a value inside the bounds", () => {
    expect(clampStorageLimitGb(50)).toBe(50)
    expect(clampStorageLimitGb(0)).toBe(STORAGE_LIMIT_GB_MIN)
    expect(clampStorageLimitGb(1e9)).toBe(STORAGE_LIMIT_GB_MAX)
  })

  it("falls back for anything that is not a finite number", () => {
    // Untreated, NaN would reach the limit as NaN, every comparison against it would be
    // false, and trimming would silently never happen.
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(clampStorageLimitGb(bad)).toBe(DEFAULT_STORAGE_LIMIT_GB)
    }
  })

  it("rounds, so the stored value matches what the input shows", () => {
    expect(clampStorageLimitGb(20.4)).toBe(20)
  })
})

describe("storageLimit", () => {
  it("is the user's cap when the quota is roomy", () => {
    expect(storageLimit(500 * GB, 20)).toEqual({ bytes: 20 * GB, reason: "cap" })
  })

  it("falls to the quota safety share when that is smaller", () => {
    // A nearly full disk: the quota has shrunk, and a fixed 20 GB cap would fill most of
    // what is left. This is the case the safety share exists for.
    expect(storageLimit(30 * GB, 20)).toEqual({
      bytes: 30 * GB * QUOTA_SAFETY_SHARE,
      reason: "quota",
    })
  })

  it("is the cap alone when the quota is unknown", () => {
    // Before the estimate resolves. The cap needs nothing from the browser, so it still
    // applies rather than turning into no limit at all.
    expect(storageLimit(0, 20)).toEqual({ bytes: 20 * GB, reason: "cap" })
    expect(storageLimit(Number.NaN, 20)).toEqual({ bytes: 20 * GB, reason: "cap" })
  })

  it("clamps the cap rather than trusting it", () => {
    expect(storageLimit(1e6 * GB, Number.NaN).bytes).toBe(
      DEFAULT_STORAGE_LIMIT_GB * GB
    )
  })
})

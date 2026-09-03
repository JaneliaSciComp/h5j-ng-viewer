import { describe, expect, it } from "vitest"
import {
  clampEvictionPercent,
  DEFAULT_EVICTION_PERCENT,
  EVICTION_PERCENT_MAX,
  EVICTION_PERCENT_MIN,
  storageBudget,
} from "@/lib/prefs"

describe("clampEvictionPercent", () => {
  it("keeps a value inside the bounds", () => {
    expect(clampEvictionPercent(50)).toBe(50)
    expect(clampEvictionPercent(1)).toBe(EVICTION_PERCENT_MIN)
    expect(clampEvictionPercent(500)).toBe(EVICTION_PERCENT_MAX)
  })

  it("falls back for anything that is not a finite number", () => {
    // A number input that has been blanked yields NaN. Untreated it would reach the
    // budget as NaN, and every comparison against it would be false -- so eviction
    // would silently never fire, which is the worst of the available failures.
    // Infinities take the same route: clamping them to the maximum would be defensible
    // too, but one rule for "not a real percentage" is easier to reason about.
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(clampEvictionPercent(bad)).toBe(DEFAULT_EVICTION_PERCENT)
    }
  })

  it("rounds, so the stored value matches what the input shows", () => {
    expect(clampEvictionPercent(80.4)).toBe(80)
  })

  it("leaves headroom by default", () => {
    // Filling the whole quota is antisocial: it is a share of one disk that every other
    // site draws on too. It also leaves nowhere for a conversion that runs over.
    expect(DEFAULT_EVICTION_PERCENT).toBeLessThan(100)
  })
})

describe("storageBudget", () => {
  it("is the given share of the quota", () => {
    expect(storageBudget(1000, 80)).toBe(800)
    expect(storageBudget(1000, 100)).toBe(1000)
  })

  it("is zero when the quota is unknown, so nothing is evicted on no information", () => {
    expect(storageBudget(0, 80)).toBe(0)
    expect(storageBudget(Number.NaN, 80)).toBe(0)
  })

  it("clamps the percentage rather than trusting it", () => {
    expect(storageBudget(1000, 5000)).toBe(1000)
    expect(storageBudget(1000, Number.NaN)).toBe(
      (1000 * DEFAULT_EVICTION_PERCENT) / 100
    )
  })
})

import { describe, expect, it } from "vitest"
import { formatBytes, usedFraction } from "@/lib/bytes"

describe("formatBytes", () => {
  it("uses whole bytes below a kilobyte", () => {
    // "0.5 KB" is worse than "512 B" at every size this branch covers.
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(1)).toBe("1 B")
  })

  it("uses binary units, matching what the storage estimate reports against", () => {
    expect(formatBytes(1024)).toBe("1.0 KB")
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB")
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB")
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB")
  })

  it("keeps one decimal above a kilobyte", () => {
    expect(formatBytes(1.3 * 1024 ** 3)).toBe("1.3 GB")
  })

  it("stops at TB rather than inventing a unit", () => {
    expect(formatBytes(5000 * 1024 ** 4)).toBe("5000.0 TB")
  })

  it("shows nothing rather than a negative or a NaN", () => {
    // `quota - usage` can go negative when a quota shrinks under a written volume, and
    // an unresolved estimate can leave a figure undefined; neither should reach the UI
    // as "-1.2 GB" or "NaN B".
    expect(formatBytes(0)).toBe("0 B")
    expect(formatBytes(-1)).toBe("0 B")
    expect(formatBytes(Number.NaN)).toBe("0 B")
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B")
  })
})

describe("usedFraction", () => {
  it("is the ratio of usage to quota", () => {
    expect(usedFraction(50, 200)).toBe(0.25)
    expect(usedFraction(0, 200)).toBe(0)
  })

  it("is null when there is no quota yet, which is not the same as empty", () => {
    // On first paint the estimate has not resolved. An empty bar would claim the
    // browser has room, and that is a claim we cannot make yet.
    expect(usedFraction(0, 0)).toBeNull()
    expect(usedFraction(10, Number.NaN)).toBeNull()
    expect(usedFraction(10, -5)).toBeNull()
  })

  it("clamps rather than overflowing the track", () => {
    expect(usedFraction(300, 200)).toBe(1)
    expect(usedFraction(-10, 200)).toBe(0)
  })
})

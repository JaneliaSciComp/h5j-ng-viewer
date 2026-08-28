import { describe, expect, it } from "vitest"
import {
  applyColorOverrides,
  contrastRanges,
  conversionOrder,
  describeGeometry,
} from "@/lib/ingest"
import type { ChannelStats } from "@/lib/stats"

const stats = (lower: number, upper: number): ChannelStats => ({
  min: lower,
  max: upper,
  lower,
  upper,
  nonZeroFraction: 0.5,
  voxels: 100,
})

describe("applyColorOverrides", () => {
  const defaults = ["#ff0000", "#00ff00", "#0000ff"]

  it("returns the defaults when the address bar asked for nothing", () => {
    expect(applyColorOverrides(defaults, null)).toEqual(defaults)
  })

  it("overrides only the positions that carry a color", () => {
    // The null entry must not shift "#ffffff" onto channel 1.
    expect(applyColorOverrides(defaults, ["#111111", null, "#ffffff"])).toEqual(
      ["#111111", "#00ff00", "#ffffff"]
    )
  })

  it("ignores overrides past the last channel", () => {
    expect(applyColorOverrides(["#ff0000"], ["#111111", "#222222"])).toEqual([
      "#111111",
    ])
  })
})

describe("contrastRanges", () => {
  it("leaves a hole for a channel that has not been measured yet", () => {
    const ranges = contrastRanges([stats(0, 174), undefined], 2)
    expect(ranges[0]).toEqual([0, 174])
    expect(ranges[1]).toBeUndefined()
  })

  it("skips a degenerate range, which would render nothing at all", () => {
    expect(contrastRanges([stats(7, 7)], 1)[0]).toBeUndefined()
  })
})

describe("describeGeometry", () => {
  it("pluralises the channel count", () => {
    const size = { x: 1210, y: 566, z: 174 }
    expect(describeGeometry(size, 1)).toBe("1210×566×174, 1 channel, 16-bit")
    expect(describeGeometry(size, 4)).toBe("1210×566×174, 4 channels, 16-bit")
  })
})

describe("conversionOrder", () => {
  it("converts the visible channels first, then the rest", () => {
    // Time-to-first-pixel then matches converting only the visible ones, even though
    // everything gets converted.
    expect(conversionOrder([false, true, false, true], 4)).toEqual([1, 3, 0, 2])
  })

  it("keeps container order within each group", () => {
    expect(conversionOrder([true, true, true], 3)).toEqual([0, 1, 2])
  })

  it("still converts everything when nothing is visible", () => {
    expect(conversionOrder([false, false], 2)).toEqual([0, 1])
  })

  it("treats a missing flag as visible", () => {
    // A short array must not silently drop channels to the back of the queue.
    expect(conversionOrder([], 3)).toEqual([0, 1, 2])
  })
})

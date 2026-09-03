import { describe, expect, it } from "vitest"
import {
  applyColorOverrides,
  contrastRanges,
  conversionOrder,
  describeGeometry,
  makeDatasetId,
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

describe("makeDatasetId", () => {
  const FEMALE =
    "https://s3.amazonaws.com/b/IS00470-20210430_43_A1-f-20x-ventral_nerve_cord-Split_GAL4-JRC2018_VNC_FEMALE_40x_DS-aligned_stack.h5j"
  const UNISEX =
    "https://s3.amazonaws.com/b/IS00470-20210430_43_A1-f-20x-ventral_nerve_cord-Split_GAL4-JRC2018_VNC_Unisex_40x_DS-aligned_stack.h5j"

  it("distinguishes names that are identical until past the truncation point", () => {
    // Real FlyLight names run past 100 characters and differ near the end. Their first
    // sixty characters are identical, so a key built from an elided name would put two
    // different volumes in one directory -- and one would silently render the other's
    // data.
    expect(makeDatasetId("a.h5j", FEMALE)).not.toBe(
      makeDatasetId("a.h5j", UNISEX)
    )
  })

  it("distinguishes the same filename in different folders", () => {
    // The display name has had its path stripped, so the identity has to be the URL.
    expect(makeDatasetId("stack.h5j", "https://x/one/stack.h5j")).not.toBe(
      makeDatasetId("stack.h5j", "https://x/two/stack.h5j")
    )
  })

  it("gives the same identity the same key, every time", () => {
    // The guarantee reuse rests on: a second load of the same file looks in the same
    // place and finds what the first one wrote. There is no timestamp any more.
    expect(makeDatasetId("a.h5j", FEMALE)).toBe(makeDatasetId("a.h5j", FEMALE))
  })

  it("keeps a readable prefix, so a key still says which file it is", () => {
    expect(makeDatasetId("IS00470-blah.h5j", FEMALE)).toMatch(/^IS00470-blah-/)
  })

  it("produces a path-safe segment needing no escaping", () => {
    const id = makeDatasetId("weird name/with:chars?.h5j", "https://x/y z.h5j")
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(encodeURIComponent(id)).toBe(id)
  })

  it("falls back to the display name when there is no URL, as for a dropped file", () => {
    expect(makeDatasetId("dropped.h5j")).toBe(
      makeDatasetId("dropped.h5j", "dropped.h5j")
    )
  })

  it("never produces a prefix that is only punctuation", () => {
    // `.` and `-` survive the character filter, so a name like `..h5j` would ask for a
    // directory named `.`. A truthiness check does not catch it, because "." is truthy.
    for (const name of ["...", "..h5j", ".h5j", "---", "._-"]) {
      expect(makeDatasetId(name, "x")).toMatch(/^volume-/)
    }
  })
})

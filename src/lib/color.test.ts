import { describe, expect, it } from "vitest"
import { hexToHsv, hsvToHex, parseHex, rgbToHex, setChannel } from "@/lib/color"
import { SWATCHES } from "@/components/ChannelPopover"

describe("parseHex", () => {
  it("accepts a hash, no hash, and any case", () => {
    expect(parseHex("#ff8000")).toEqual([255, 128, 0])
    expect(parseHex("FF8000")).toEqual([255, 128, 0])
    expect(parseHex("  #ff8000 ")).toEqual([255, 128, 0])
  })

  it("rejects anything else rather than guessing", () => {
    // A half-typed value in a text field must not be applied as a color.
    expect(parseHex("#fff")).toBeNull()
    expect(parseHex("#ff800")).toBeNull()
    expect(parseHex("orange")).toBeNull()
    expect(parseHex("")).toBeNull()
  })
})

describe("hex and hsv round-trip", () => {
  it("survives every preset unchanged", () => {
    // The presets are the values most likely to be picked and re-picked, so a rounding
    // drift here would slowly walk a channel's color away from the palette.
    for (const swatch of SWATCHES) {
      expect(hsvToHex(hexToHsv(swatch))).toBe(swatch)
    }
  })

  it("survives the primaries and the extremes", () => {
    for (const hex of [
      "#000000",
      "#ffffff",
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#7f7f7f",
      "#010203",
    ]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex)
    }
  })
})

describe("hexToHsv", () => {
  it("reads the primaries at the expected hues", () => {
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 })
    expect(hexToHsv("#00ff00")).toEqual({ h: 120, s: 1, v: 1 })
    expect(hexToHsv("#0000ff")).toEqual({ h: 240, s: 1, v: 1 })
  })

  it("reports grays as unsaturated", () => {
    expect(hexToHsv("#808080").s).toBe(0)
    expect(hexToHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 })
  })

  it("returns black for an unparseable value rather than throwing", () => {
    expect(hexToHsv("nonsense")).toEqual({ h: 0, s: 0, v: 0 })
  })
})

describe("hsvToHex", () => {
  it("wraps hue rather than clipping it, so a slider can cross 360", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000")
    expect(hsvToHex({ h: -60, s: 1, v: 1 })).toBe(
      hsvToHex({ h: 300, s: 1, v: 1 })
    )
  })

  it("clamps saturation and value into range", () => {
    expect(hsvToHex({ h: 0, s: 5, v: 5 })).toBe("#ff0000")
    expect(hsvToHex({ h: 0, s: -1, v: -1 })).toBe("#000000")
  })
})

describe("rgbToHex", () => {
  it("rounds and clamps out-of-range channels", () => {
    expect(rgbToHex(255.6, -3, 127.5)).toBe("#ff0080")
  })
})

describe("setChannel", () => {
  it("changes only the channel named", () => {
    // The obvious failure here is a silent one: green and blue swapped looks like a
    // color, just not the one that was asked for.
    expect(setChannel("#102030", "r", 255)).toBe("#ff2030")
    expect(setChannel("#102030", "g", 255)).toBe("#10ff30")
    expect(setChannel("#102030", "b", 255)).toBe("#1020ff")
  })

  it("clamps and rounds like any other channel write", () => {
    expect(setChannel("#000000", "r", 300)).toBe("#ff0000")
    expect(setChannel("#ffffff", "g", -5)).toBe("#ff00ff")
  })

  it("treats an unparseable color as black rather than throwing", () => {
    expect(setChannel("nonsense", "b", 128)).toBe("#000080")
  })
})

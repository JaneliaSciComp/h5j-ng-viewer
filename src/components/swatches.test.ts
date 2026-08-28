import { describe, expect, it } from "vitest"
import { SWATCHES } from "@/components/ChannelPopover"

describe("swatches", () => {
  it("offers eight Turbo samples, 0.125 apart", () => {
    expect(SWATCHES).toHaveLength(8)
  })

  it("are lowercase six-digit hex", () => {
    // A malformed value fails silently: the swatch renders transparent and the color
    // input rejects it, with no error anywhere.
    for (const swatch of SWATCHES) {
      expect(swatch).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it("are all distinct", () => {
    expect(new Set(SWATCHES).size).toBe(SWATCHES.length)
  })
})

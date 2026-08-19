import { describe, expect, it } from "vitest"
import type { H5JInfo } from "@/types"
import {
  defaultChannelColors,
  parseH5JInfo,
  projectedOutputBytes,
  resolveDims,
} from "@/lib/h5j"

// getFFmpeg, openSource and decodeChannel all need a browser (ffmpeg.wasm,
// FileReader/fetch) -- they are exercised at Milestone 3+ against a real
// browser, not here.

describe("parseH5JInfo", () => {
  it("parses an attrs object shaped like testData/w256h128d64.yml", () => {
    // Mirrors ../web-h5j-loader/testData/w256h128d64.yml plus the `names` /
    // `content_types` arrays that getH5JAttrs adds from the Channels group's
    // child keys and their `content_type` attrs.
    const attrs = {
      image_size: [256, 128, 64],
      voxel_size: [0.44, 0.44, 0.44],
      channel_spec: "r",
      channels: {
        frames: [64],
        height: [128],
        pad_bottom: [0],
        pad_right: [0],
        width: [256],
        names: ["Channel_0"],
        content_types: ["reference"],
      },
    }

    const info = parseH5JInfo(attrs)

    expect(info.nominalSize).toEqual({ x: 256, y: 128, z: 64 })
    expect(info.voxelSize).toEqual({ x: 0.44, y: 0.44, z: 0.44 })
    expect(info.channelSpec).toBe("r")
    expect(info.channels).toEqual([
      { name: "Channel_0", contentType: "reference" },
    ])
  })
})

// Minimal H5JInfo fixture for resolveDims, which only reads nominalSize,
// voxelSize and attrs.channels.{pad_right,pad_bottom}.
function makeInfo(overrides: {
  width: number
  height: number
  frames: number
  padRight?: number
  padBottom?: number
  voxelSize?: H5JInfo["voxelSize"]
}): H5JInfo {
  return {
    channels: [{ name: "Channel_0" }],
    nominalSize: {
      x: overrides.width,
      y: overrides.height,
      z: overrides.frames,
    },
    // `??` would treat an explicit `voxelSize: undefined` the same as "not
    // provided" and mask the default -- distinguish the two with `in`.
    voxelSize:
      "voxelSize" in overrides
        ? overrides.voxelSize
        : { x: 0.44, y: 0.44, z: 0.44 },
    channelSpec: "r",
    attrs: {
      channels: {
        width: [overrides.width],
        height: [overrides.height],
        frames: [overrides.frames],
        pad_right: [overrides.padRight ?? 0],
        pad_bottom: [overrides.padBottom ?? 0],
      },
    },
  }
}

describe("resolveDims", () => {
  it("(a) fits exactly with no padding", () => {
    const info = makeInfo({ width: 256, height: 128, frames: 64 })
    const dims = resolveDims(info, 256 * 128 * 64)

    expect(dims.size).toEqual({ x: 256, y: 128, z: 64 })
    expect(dims.padX).toBe(256)
    expect(dims.padY).toBe(128)
    expect(dims.warnings).toEqual([])
  })

  it("(b) resolves padding declared via pad_right/pad_bottom", () => {
    // padW = 256 + 8 = 264, padH = 128 + 8 = 136. The ceil-8 fallback (256, 128)
    // would also divide evenly here, but the pad_right/pad_bottom candidate has
    // priority and is tried first, so it wins.
    const info = makeInfo({
      width: 256,
      height: 128,
      frames: 64,
      padRight: 8,
      padBottom: 8,
    })
    const decodedVoxelCount = 264 * 136 * 64

    const dims = resolveDims(info, decodedVoxelCount)

    expect(dims.padX).toBe(264)
    expect(dims.padY).toBe(136)
    expect(dims.size).toEqual({ x: 256, y: 128, z: 64 })
    expect(dims.warnings).toHaveLength(1)
    expect(dims.warnings[0]).toMatch(/padded/i)
  })

  it("(c) resolves padding via the ceil-8 fallback", () => {
    // trueW = 1210 -> 1210 / 8 = 151.25 -> ceil = 152 -> padW = 152 * 8 = 1216
    // trueH = 566  -> 566 / 8 = 70.75   -> ceil = 71  -> padH = 71 * 8 = 568
    // With pad_right/pad_bottom both 0, the first candidate pair is
    // (1210, 566) (the unpadded size), which must NOT evenly divide the
    // decoded voxel count, so resolution falls through to (1216, 568):
    //   1216 * 568 = 690688
    //   690688 * 174 = 120179712   (nZ = 174, matching R10E08's real z extent)
    //   120179712 % (1210 * 566) = 120179712 % 684860 = 329212 (!= 0)
    //   120179712 % (1216 * 568) = 120179712 % 690688 = 0
    const decodedVoxelCount = 1216 * 568 * 174
    expect(decodedVoxelCount % (1210 * 566)).not.toBe(0)
    expect(decodedVoxelCount % (1216 * 568)).toBe(0)

    const info = makeInfo({ width: 1210, height: 566, frames: 174 })
    const dims = resolveDims(info, decodedVoxelCount)

    expect(dims.padX).toBe(1216)
    expect(dims.padY).toBe(568)
    expect(dims.size).toEqual({ x: 1210, y: 566, z: 174 })
    expect(dims.warnings).toHaveLength(1)
    expect(dims.warnings[0]).toMatch(/padded/i)
  })

  it("(d) derives nZ from the data when it disagrees with nominal frames", () => {
    const info = makeInfo({ width: 256, height: 128, frames: 64 })
    const decodedVoxelCount = 256 * 128 * 70 // decoder actually produced 70 frames

    const dims = resolveDims(info, decodedVoxelCount)

    expect(dims.size.z).toBe(70)
    expect(dims.warnings).toHaveLength(1)
    expect(dims.warnings[0]).toMatch(/disagrees/i)
  })

  it("(e) falls back to {1,1,1} with a warning when voxel_size is missing", () => {
    const info = makeInfo({
      width: 256,
      height: 128,
      frames: 64,
      voxelSize: undefined,
    })

    const dims = resolveDims(info, 256 * 128 * 64)

    expect(dims.voxelSize).toEqual({ x: 1, y: 1, z: 1 })
    expect(dims.warnings.some((w) => /voxel_size/i.test(w))).toBe(true)
  })

  it("(f) throws when the decoded voxel count fits no candidate", () => {
    const info = makeInfo({ width: 256, height: 128, frames: 64 })
    expect(() => resolveDims(info, 999999)).toThrow()
  })
})

describe("resolveDims picks the aligned layout when the unpadded one also divides", () => {
  // Regression: `pad_right`/`pad_bottom` of 0 used to be admitted as a real
  // "no padding" candidate and tried before the macroblock-alignment rule. For
  // plenty of realistic sizes the unpadded area also divides the padded voxel
  // count, so the wrong candidate won and produced a short row stride -- which
  // shears the volume instead of failing.
  it("resolves 100x156 padded to 104x160 with 15 frames, not 100x156 with 16", () => {
    const info = makeInfo({ width: 100, height: 156, frames: 15 })
    // The decoder emits macroblock-aligned frames: 100 -> 104, 156 -> 160.
    const decoded = 104 * 160 * 15
    expect(decoded).toBe(249600)
    // The trap: the unpadded area divides that count exactly, one frame too many.
    expect(decoded % (100 * 156)).toBe(0)
    expect(decoded / (100 * 156)).toBe(16)

    const dims = resolveDims(info, decoded)
    expect({ padX: dims.padX, padY: dims.padY, z: dims.size.z }).toEqual({
      padX: 104,
      padY: 160,
      z: 15,
    })
    expect(dims.size.x).toBe(100)
    expect(dims.size.y).toBe(156)
  })

  it("still honours padding the file declares explicitly", () => {
    // Declared padding that is NOT the multiple-of-8 rule must still win, so the
    // fix cannot have simply hardcoded alignment.
    const info = makeInfo({
      width: 100,
      height: 156,
      frames: 15,
      padRight: 12,
      padBottom: 4,
    })
    const dims = resolveDims(info, 112 * 160 * 15)
    expect({ padX: dims.padX, padY: dims.padY, z: dims.size.z }).toEqual({
      padX: 112,
      padY: 160,
      z: 15,
    })
  })
})

describe("defaultChannelColors", () => {
  it("maps recognised channel_spec characters", () => {
    expect(defaultChannelColors("rgb", 3)).toEqual([
      "#ff0000",
      "#00ff00",
      "#0000ff",
    ])
  })

  it("falls back to the palette when the spec is shorter than count", () => {
    const colors = defaultChannelColors("r", 3)
    expect(colors).toHaveLength(3)
    expect(colors[0]).toBe("#ff0000")
    expect(colors[1]).toBe("#00ff00") // FALLBACK_PALETTE[1]
    expect(colors[2]).toBe("#00ffff") // FALLBACK_PALETTE[2]
  })

  it("falls back to the palette for unrecognised characters", () => {
    const colors = defaultChannelColors("rzb", 3)
    expect(colors[0]).toBe("#ff0000")
    expect(colors[1]).toBe("#00ff00") // 'z' is unrecognised -> FALLBACK_PALETTE[1]
    expect(colors[2]).toBe("#0000ff")
  })

  it("falls back to the palette entirely when spec is undefined", () => {
    expect(defaultChannelColors(undefined, 4)).toEqual([
      "#ff00ff",
      "#00ff00",
      "#00ffff",
      "#ffffff",
    ])
  })

  it("returns an empty array for count 0", () => {
    expect(defaultChannelColors("rgb", 0)).toEqual([])
  })

  it("always returns exactly `count` entries", () => {
    expect(defaultChannelColors("r", 5)).toHaveLength(5)
    expect(defaultChannelColors(undefined, 7)).toHaveLength(7)
  })
})

describe("projectedOutputBytes", () => {
  const size = { x: 256, y: 128, z: 64 }

  it("is monotonic in channel count", () => {
    const one = projectedOutputBytes(size, 1, 16)
    const two = projectedOutputBytes(size, 2, 16)
    expect(two).toBeGreaterThan(one)
    expect(two).toBe(one * 2)
  })

  it("is monotonic in bit depth", () => {
    const bits8 = projectedOutputBytes(size, 1, 8)
    const bits16 = projectedOutputBytes(size, 1, 16)
    expect(bits16).toBeGreaterThan(bits8)
    expect(bits16).toBe(bits8 * 2)
  })
})

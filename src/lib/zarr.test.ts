import { describe, expect, it } from "vitest"
import type { Vec3 } from "@/types"
import {
  CHUNK,
  MAX_LEVEL_DIM,
  bytesPerVoxel,
  buildZarray,
  buildZattrs,
  chunkBytes,
  chunkGrid,
  downsample2x,
  gatherChunk,
  maxValue,
  pyramid,
  zarrDtype,
} from "./zarr"

describe("chunkGrid", () => {
  it("exact multiples", () => {
    expect(chunkGrid({ x: 128, y: 128, z: 128 })).toEqual([2, 2, 2])
  })

  it("non-multiples round up per axis", () => {
    // z=63 -> 1 chunk, y=64 -> 1 chunk (exact), x=65 -> 2 chunks
    expect(chunkGrid({ x: 65, y: 64, z: 63 })).toEqual([1, 1, 2])
  })
})

describe("pyramid", () => {
  it("256x128x64 (w256h128d64 test volume)", () => {
    const levels = pyramid({ x: 256, y: 128, z: 64 })
    expect(levels.length).toBe(2)
    expect(levels[0].size).toEqual({ x: 256, y: 128, z: 64 })
    expect(levels[1].size).toEqual({ x: 128, y: 64, z: 32 })
    const last = levels[levels.length - 1].size
    expect(Math.max(last.x, last.y, last.z)).toBeLessThanOrEqual(MAX_LEVEL_DIM)
  })

  it("1210x566x174 test volume", () => {
    const levels = pyramid({ x: 1210, y: 566, z: 174 })
    expect(levels.length).toBe(5)
    expect(levels[0].size).toEqual({ x: 1210, y: 566, z: 174 })
    const expectedSizes = [
      { x: 1210, y: 566, z: 174 },
      { x: 605, y: 283, z: 87 },
      { x: 303, y: 142, z: 44 },
      { x: 152, y: 71, z: 22 },
      { x: 76, y: 36, z: 11 },
    ]
    levels.forEach((lvl, i) => expect(lvl.size).toEqual(expectedSizes[i]))
    // dims never go below 1 and factors double each level
    levels.forEach((lvl, i) => {
      expect(lvl.factor).toBe(2 ** i)
      expect(lvl.size.x).toBeGreaterThanOrEqual(1)
      expect(lvl.size.y).toBeGreaterThanOrEqual(1)
      expect(lvl.size.z).toBeGreaterThanOrEqual(1)
    })
    const last = levels[levels.length - 1].size
    expect(Math.max(last.x, last.y, last.z)).toBeLessThanOrEqual(MAX_LEVEL_DIM)
  })
})

describe("bit-depth helpers", () => {
  it("bytesPerVoxel", () => {
    expect(bytesPerVoxel(8)).toBe(1)
    expect(bytesPerVoxel(16)).toBe(2)
  })

  it("zarrDtype", () => {
    expect(zarrDtype(8)).toBe("|u1")
    expect(zarrDtype(16)).toBe("<u2")
  })

  it("maxValue is 4095 for 16-bit, NOT 65535 (F11: unscaled 12-bit data)", () => {
    expect(maxValue(16)).toBe(4095)
    expect(maxValue(8)).toBe(255)
  })

  it("chunkBytes", () => {
    expect(chunkBytes(8)).toBe(64 * 64 * 64)
    expect(chunkBytes(16)).toBe(64 * 64 * 64 * 2)
  })
})

// A naive, obviously-correct reference implementation of the same contract as
// gatherChunk. Used to cross-check the fast (row-run) implementation instead of
// hand-encoding expected values, which gets unwieldy once three axes are involved.
function naiveGather(
  src: Uint16Array,
  size: Vec3,
  strideX: number,
  strideY: number,
  chunkZ: number,
  chunkY: number,
  chunkX: number
): Uint16Array {
  const [CZ, CY, CX] = CHUNK
  const out = new Uint16Array(CZ * CY * CX)
  for (let z = 0; z < CZ; z++) {
    const sz = chunkZ * CZ + z
    if (sz >= size.z) continue
    for (let y = 0; y < CY; y++) {
      const sy = chunkY * CY + y
      if (sy >= size.y) continue
      for (let x = 0; x < CX; x++) {
        const sx = chunkX * CX + x
        if (sx >= size.x) continue
        out[(z * CY + y) * CX + x] = src[(sz * strideY + sy) * strideX + sx]
      }
    }
  }
  return out
}

describe("gatherChunk", () => {
  // Bigger than one chunk (64) on every axis, so chunk (0,0,0) is fully interior
  // and chunk (1,1,1) is a genuine edge chunk, partially out of range on all axes.
  const size: Vec3 = { x: 100, y: 70, z: 70 }

  function fillVolume(strideX: number, strideY: number, strideZ: number) {
    const buf = new Uint16Array(strideX * strideY * strideZ)
    for (let z = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++) {
          // Arbitrary but deterministic -- doesn't need to be unique, since the
          // reference implementation reads from this same buffer.
          buf[(z * strideY + y) * strideX + x] =
            (x * 13 + y * 7 + z * 3 + 1) % 4096
        }
      }
    }
    return buf
  }

  it("interior chunk matches the reference implementation exactly", () => {
    const src = fillVolume(size.x, size.y, size.z)
    const out = new Uint16Array(CHUNK[0] * CHUNK[1] * CHUNK[2])
    gatherChunk(src, size, size.x, size.y, 0, 0, 0, out)
    expect(out).toEqual(naiveGather(src, size, size.x, size.y, 0, 0, 0))
    // Sanity: an interior chunk should have no zero padding at all.
    expect(out.includes(0)).toBe(false)
  })

  it("edge chunk zero-pads out-of-volume positions and matches the reference", () => {
    const src = fillVolume(size.x, size.y, size.z)
    const out = new Uint16Array(CHUNK[0] * CHUNK[1] * CHUNK[2])
    gatherChunk(src, size, size.x, size.y, 1, 1, 1, out)
    expect(out).toEqual(naiveGather(src, size, size.x, size.y, 1, 1, 1))
    // grid is [2,2,2]; chunk (1,1,1) covers z in [64,128), y in [64,128), x in [64,128)
    // but the volume only has 6, 6 and 36 valid voxels on those axes respectively --
    // most of the chunk must be zero.
    const zeroCount = out.filter((v) => v === 0).length
    expect(zeroCount).toBeGreaterThan(0)
  })

  it("crops padding for free when strideX/strideY exceed size (level-0 case)", () => {
    const padX = 128
    const padY = 96
    const src = new Uint16Array(padX * padY * size.z).fill(9999) // sentinel padding
    for (let z = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++) {
          src[(z * padY + y) * padX + x] = (x * 13 + y * 7 + z * 3 + 1) % 4096
        }
      }
    }
    const out = new Uint16Array(CHUNK[0] * CHUNK[1] * CHUNK[2])
    gatherChunk(src, size, padX, padY, 1, 1, 1, out)
    expect(out).toEqual(naiveGather(src, size, padX, padY, 1, 1, 1))
    // The sentinel value must never leak into the gathered chunk.
    expect(out.includes(9999)).toBe(false)
  })
})

describe("downsample2x", () => {
  it("constant volume downsamples to the same constant", () => {
    const size: Vec3 = { x: 4, y: 4, z: 4 }
    const src = new Uint16Array(size.x * size.y * size.z).fill(7)
    const { data, size: outSize } = downsample2x(src, size, size.x, size.y)
    expect(outSize).toEqual({ x: 2, y: 2, z: 2 })
    expect(Array.from(data).every((v) => v === 7)).toBe(true)
  })

  it("gradient averages exactly (step size 2 keeps every average an integer)", () => {
    const size: Vec3 = { x: 6, y: 4, z: 4 }
    const src = new Uint16Array(size.x * size.y * size.z)
    for (let z = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++) {
          // value depends only on x, step 2 -> every adjacent pair averages exactly
          src[(z * size.y + y) * size.x + x] = x * 2
        }
      }
    }
    const { data, size: outSize } = downsample2x(src, size, size.x, size.y)
    expect(outSize).toEqual({ x: 3, y: 2, z: 2 })
    const expectedRow = [1, 5, 9] // avg(0,2)=1, avg(4,6)=5, avg(8,10)=9
    for (let oz = 0; oz < outSize.z; oz++) {
      for (let oy = 0; oy < outSize.y; oy++) {
        const row = Array.from(
          data.subarray(
            (oz * outSize.y + oy) * outSize.x,
            (oz * outSize.y + oy) * outSize.x + outSize.x
          )
        )
        expect(row).toEqual(expectedRow)
      }
    }
  })

  it("odd dimension: last output sample averages a single source sample, not two", () => {
    // x, y are even and unused (constant); z is odd (5) so the last z-bucket has
    // only one valid source plane. If the implementation read out of bounds or
    // divided by 2 regardless of count, this would be wrong.
    const size: Vec3 = { x: 2, y: 2, z: 5 }
    const src = new Uint16Array(size.x * size.y * size.z)
    for (let z = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++) {
          src[(z * size.y + y) * size.x + x] = z * 10
        }
      }
    }
    const { data, size: outSize } = downsample2x(src, size, size.x, size.y)
    expect(outSize).toEqual({ x: 1, y: 1, z: 3 })
    // z buckets: avg(0,10)=5, avg(20,30)=25, avg(40)=40 (single sample, not 20)
    expect(Array.from(data)).toEqual([5, 25, 40])
  })
})

describe("buildZarray", () => {
  it("shape and dtype for 8-bit", () => {
    const z = buildZarray({ x: 10, y: 20, z: 30 }, 3, 8) as {
      shape: number[]
      dtype: string
      chunks: number[]
    }
    expect(z.shape).toEqual([3, 30, 20, 10])
    expect(z.dtype).toBe("|u1")
    expect(z.chunks).toEqual([1, 64, 64, 64])
  })

  it("shape and dtype for 16-bit", () => {
    const z = buildZarray({ x: 10, y: 20, z: 30 }, 2, 16) as {
      shape: number[]
      dtype: string
    }
    expect(z.shape).toEqual([2, 30, 20, 10])
    expect(z.dtype).toBe("<u2")
  })
})

describe("buildZattrs", () => {
  it("scale factors per level and channel metadata", () => {
    const levels = pyramid({ x: 256, y: 128, z: 64 })
    const attrs = buildZattrs({
      datasetName: "test",
      levels,
      voxelSize: { x: 0.5, y: 0.5, z: 1 },
      channelNames: ["red", "green"],
      channelColors: ["#ff0000", "#00ff00"],
      bits: 16,
    }) as {
      multiscales: Array<{
        datasets: Array<{
          path: string
          coordinateTransformations: Array<{ scale: number[] }>
        }>
      }>
      omero: {
        channels: Array<{
          label: string
          color: string
          window: { max: number }
        }>
      }
    }

    const datasets = attrs.multiscales[0].datasets
    expect(datasets.length).toBe(levels.length)
    datasets.forEach((ds, i) => {
      expect(ds.path).toBe(String(i))
      expect(ds.coordinateTransformations[0].scale).toEqual([
        1,
        1 * levels[i].factor,
        0.5 * levels[i].factor,
        0.5 * levels[i].factor,
      ])
    })

    expect(attrs.omero.channels.length).toBe(2)
    expect(attrs.omero.channels[0].label).toBe("red")
    // color must not carry the leading '#' (omero convention)
    expect(attrs.omero.channels[0].color).toBe("ff0000")
    expect(attrs.omero.channels[0].window.max).toBe(4095)
  })
})

import { describe, expect, it } from "vitest"
import type { Vec3 } from "@/types"
import { maxValue } from "@/lib/zarr"
import { measureChannel } from "@/lib/stats"

describe("measureChannel", () => {
  it("constant volume falls back to the full dtype range", () => {
    const size: Vec3 = { x: 4, y: 4, z: 4 }
    const data = new Uint16Array(64).fill(100)
    const stats = measureChannel(data, size, size.x, size.y, 16)
    expect(stats.min).toBe(100)
    expect(stats.max).toBe(100)
    // Percentiles coincide at 100, and so does the min/max fallback -- only the
    // final [0, maxValue] fallback can produce a non-zero-width range here.
    expect(stats.upper).toBeGreaterThan(stats.lower)
    expect(stats.lower).toBe(0)
    expect(stats.upper).toBe(maxValue(16))
  })

  it("all-zero volume: nonZeroFraction is 0, range still non-zero-width", () => {
    const size: Vec3 = { x: 4, y: 4, z: 4 }
    const data = new Uint8Array(64) // all zero
    const stats = measureChannel(data, size, size.x, size.y, 8)
    expect(stats.min).toBe(0)
    expect(stats.max).toBe(0)
    expect(stats.nonZeroFraction).toBe(0)
    expect(stats.upper).toBeGreaterThan(stats.lower)
    expect(stats.lower).toBe(0)
    expect(stats.upper).toBe(maxValue(8))
  })

  it("gradient: percentiles match hand-computed nearest-rank values", () => {
    // 4096 voxels, values 0..4095 each exactly once (16-bit, no padding).
    const size: Vec3 = { x: 4096, y: 1, z: 1 }
    const data = new Uint16Array(4096)
    for (let i = 0; i < 4096; i++) data[i] = i
    const stats = measureChannel(data, size, size.x, size.y, 16)
    expect(stats.min).toBe(0)
    expect(stats.max).toBe(4095)
    // 0.1th percentile: target = 0.001 * 4096 = 4.096. Cumulative count reaches
    // 5 (> 4.096) at value 4 (values 0..4 = 5 voxels), so lower = 4.
    expect(stats.lower).toBe(4)
    // 99.9th percentile: target = 0.999 * 4096 = 4091.904. Cumulative count
    // reaches 4092 (> 4091.904) at value 4091 (values 0..4091 = 4092 voxels).
    expect(stats.upper).toBe(4091)
  })

  it("excludes padding from min/max and voxel count", () => {
    // Padded buffer is 4 wide x 3 tall x 2 deep; the real volume is 2x2x2 in
    // the corner. Fill everything with the dtype max, then set only the
    // in-volume voxels to a much smaller value.
    const size: Vec3 = { x: 2, y: 2, z: 2 }
    const strideX = 4
    const strideY = 3
    const top = maxValue(8)
    const data = new Uint8Array(size.z * strideY * strideX).fill(top)
    for (let z = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++) {
          data[(z * strideY + y) * strideX + x] = 5
        }
      }
    }
    const stats = measureChannel(data, size, strideX, strideY, 8)
    expect(stats.voxels).toBe(size.x * size.y * size.z)
    expect(stats.max).toBe(5) // would be `top` if padding leaked in
    expect(stats.min).toBe(5)
  })

  it("mostly-zero volume with a few bright voxels: upper tracks the signal, not the background", () => {
    const size: Vec3 = { x: 1000, y: 1, z: 1 }
    const data = new Uint16Array(1000) // starts all zero
    for (let i = 0; i < 10; i++) data[i] = 3000
    const stats = measureChannel(data, size, size.x, size.y, 16)
    expect(stats.nonZeroFraction).toBe(0.01)
    // target = 0.999 * 1000 = 999. The 990 background zeros carry cumulative
    // count to 990; it only exceeds 999 once the 10 bright voxels at 3000 are
    // included, so upper lands exactly on the bright value, not on 0.
    expect(stats.upper).toBe(3000)
  })
})

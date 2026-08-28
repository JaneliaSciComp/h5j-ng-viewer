// Integration tests for the one invariant that spans two files and cannot be checked
// from either side alone: the ingest worker writes chunks in a fixed order, and the
// service worker recovers each chunk's byte offset by arithmetic alone. If those two
// ever disagree, every test in zarr.test.ts still passes and the viewer shows garbage.

import { describe, expect, it } from "vitest"
import {
  CHUNK,
  chunkBytes,
  chunkGrid,
  chunkVoxels,
  downsample2x,
  gatherChunk,
  pyramid,
} from "@/lib/zarr"
import type { Vec3 } from "@/types"

const CHUNK_VOXELS = chunkVoxels()

/** The service worker's offset formula, restated here and cross-checked below. */
const chunkOffset = (
  grid: [number, number, number],
  z: number,
  y: number,
  x: number,
  bytes: number
) => ((z * grid[1] + y) * grid[2] + x) * bytes

describe("pyramid geometry agrees with what downsample2x produces", () => {
  // pyramid() declares the level sizes that go into .zarray, while downsample2x
  // produces the actual data. A mismatch of even one voxel on one axis means the
  // declared shape and the stored bytes disagree, which surfaces as truncated or
  // shifted slices rather than a clean error.
  it.each([
    { x: 256, y: 128, z: 64 },
    { x: 1210, y: 566, z: 174 },
    { x: 64, y: 64, z: 64 },
    { x: 129, y: 3, z: 1 },
  ])("matches for %o", (size: Vec3) => {
    const levels = pyramid(size)
    let current = { data: new Uint8Array(1), size }

    for (const level of levels) {
      if (level.level > 0) {
        // Only the sizes matter here, so downsample a correctly-sized dummy volume.
        const source = new Uint8Array(
          current.size.x * current.size.y * current.size.z
        )
        current = downsample2x(
          source,
          current.size,
          current.size.x,
          current.size.y
        )
      }
      expect(level.size).toEqual(current.size)
      expect(level.grid).toEqual(chunkGrid(level.size))
    }

    const last = levels[levels.length - 1].size
    expect(Math.max(last.x, last.y, last.z)).toBeLessThanOrEqual(128)
  })
})

describe("packed layout round-trips through the service worker's offset formula", () => {
  it("reads back every voxel of every chunk at its computed offset", () => {
    // Small enough to brute-force, large enough to span several chunks on each axis
    // and to have partial chunks on all three.
    const size: Vec3 = { x: 100, y: 70, z: 66 }
    // Deliberately padded, as a level-0 buffer from the H5J decoder always is.
    const padX = 104
    const padY = 72
    const bits = 16 as const
    const bytesPerChunk = chunkBytes(bits)
    const grid = chunkGrid(size)

    const expected = (x: number, y: number, z: number) =>
      ((x * 7 + y * 13 + z * 31) % 4093) + 1

    const source = new Uint16Array(padX * padY * size.z)
    // Fill the padding with a sentinel so a crop bug cannot pass silently.
    source.fill(0xffff)
    for (let z = 0; z < size.z; z += 1) {
      for (let y = 0; y < size.y; y += 1) {
        for (let x = 0; x < size.x; x += 1) {
          source[(z * padY + y) * padX + x] = expected(x, y, z)
        }
      }
    }

    // Replay the ingest worker's write loop exactly: z outer, then y, then x, each
    // chunk appended at the write cursor. One array per channel means the cursor is
    // always where the chunk belongs -- the interleaving this test used to check went
    // away with the shared chunk.
    const packed = new Uint16Array(
      (grid[0] * grid[1] * grid[2] * bytesPerChunk) / 2
    )
    const scratch = new Uint16Array(CHUNK_VOXELS)
    let cursor = 0
    for (let z = 0; z < grid[0]; z += 1) {
      for (let y = 0; y < grid[1]; y += 1) {
        for (let x = 0; x < grid[2]; x += 1) {
          gatherChunk(source, size, padX, padY, z, y, x, scratch)
          packed.set(scratch, cursor)
          cursor += CHUNK_VOXELS
        }
      }
    }
    expect(packed.byteLength).toBe(grid[0] * grid[1] * grid[2] * bytesPerChunk)

    // Read every voxel back the way the viewer would: locate the chunk via the service
    // worker's byte offset, then index within it. Compare in a plain loop and assert
    // once -- a per-voxel `expect` would take longer than the rest of the suite.
    let checked = 0
    let mismatch: string | null = null
    for (let cz = 0; cz < grid[0] && !mismatch; cz += 1) {
      for (let cy = 0; cy < grid[1] && !mismatch; cy += 1) {
        for (let cx = 0; cx < grid[2] && !mismatch; cx += 1) {
          const base = chunkOffset(grid, cz, cy, cx, bytesPerChunk) / 2
          for (let iz = 0; iz < CHUNK[0] && !mismatch; iz += 1) {
            const z = cz * CHUNK[0] + iz
            for (let iy = 0; iy < CHUNK[1] && !mismatch; iy += 1) {
              const y = cy * CHUNK[1] + iy
              for (let ix = 0; ix < CHUNK[2]; ix += 1) {
                const x = cx * CHUNK[2] + ix
                const value = packed[base + (iz * CHUNK[1] + iy) * CHUNK[2] + ix]
                // Out-of-volume positions must be zero-padded, and the sentinel must
                // never appear -- that would mean the source padding leaked through.
                const want =
                  x < size.x && y < size.y && z < size.z ? expected(x, y, z) : 0
                checked += 1
                if (value !== want) {
                  mismatch = `at x=${x} y=${y} z=${z}: got ${value}, want ${want}`
                  break
                }
              }
            }
          }
        }
      }
    }
    expect(mismatch).toBeNull()
    expect(checked).toBe(packed.length)
  })
})

// OME-Zarr 0.4 / zarr v2 metadata builders plus the pure numeric helpers ingest
// and the service worker both depend on: chunk-grid math, the downsample pyramid,
// and the chunk gather/downsample kernels themselves. See notes/implementation-plan.md
// section 6 for the on-disk layout this produces.

import type { BitDepth, LevelInfo, Vec3 } from "@/types"

/** Chunk shape on the spatial axes, as [z, y, x]. The zarr `chunks` field is [1, ...this]. */
export const CHUNK: readonly [number, number, number] = [64, 64, 64]

/** Stop building pyramid levels once max(size) <= this. */
export const MAX_LEVEL_DIM = 128

export function bytesPerVoxel(bits: BitDepth): 1 | 2 {
  return bits === 8 ? 1 : 2
}

export function zarrDtype(bits: BitDepth): "|u1" | "<u2" {
  return bits === 8 ? "|u1" : "<u2"
}

/**
 * Largest value the decoded data can hold. F11: the 16-bit path carries UNSCALED
 * 12-bit values out of the H.265 decode, so this is 4095 -- not 65535 -- and the
 * `invlerp` shader range must match or the viewer will look nearly black.
 */
export function maxValue(bits: BitDepth): number {
  return bits === 8 ? 255 : 4095
}

/** Chunk-grid extent as [z, y, x] = ceil(size / CHUNK). */
export function chunkGrid(size: Vec3): [number, number, number] {
  return [
    Math.ceil(size.z / CHUNK[0]),
    Math.ceil(size.y / CHUNK[1]),
    Math.ceil(size.x / CHUNK[2]),
  ]
}

/** Uncompressed bytes in one chunk. Also the chunk stride in the packed file. */
export function chunkBytes(bits: BitDepth): number {
  return CHUNK[0] * CHUNK[1] * CHUNK[2] * bytesPerVoxel(bits)
}

/**
 * Pyramid levels from full resolution down to max(size) <= MAX_LEVEL_DIM, halving
 * x, y and z each step. Halving uses ceil (not floor) so that an odd extent still
 * covers every source voxel -- this matches `downsample2x`'s own output size, which
 * is what actually gets written to disk for each level.
 */
export function pyramid(size: Vec3): LevelInfo[] {
  const levels: LevelInfo[] = []
  let cur = size
  let level = 0
  let factor = 1
  // Level 0 is always emitted first, even if it already satisfies MAX_LEVEL_DIM.
  for (;;) {
    levels.push({ level, size: cur, grid: chunkGrid(cur), factor })
    if (Math.max(cur.x, cur.y, cur.z) <= MAX_LEVEL_DIM) break
    cur = {
      x: Math.max(1, Math.ceil(cur.x / 2)),
      y: Math.max(1, Math.ceil(cur.y / 2)),
      z: Math.max(1, Math.ceil(cur.z / 2)),
    }
    level += 1
    factor *= 2
  }
  return levels
}

export function buildZgroup(): object {
  return { zarr_format: 2 }
}

export function buildZarray(
  size: Vec3,
  channelCount: number,
  bits: BitDepth
): object {
  return {
    zarr_format: 2,
    shape: [channelCount, size.z, size.y, size.x],
    chunks: [1, ...CHUNK],
    dtype: zarrDtype(bits),
    compressor: null,
    fill_value: 0,
    order: "C",
    filters: null,
    dimension_separator: ".",
  }
}

export function buildZattrs(opts: {
  datasetName: string
  levels: LevelInfo[]
  /** micrometers per voxel at level 0 */
  voxelSize: Vec3
  channelNames: string[]
  channelColors: string[]
  bits: BitDepth
}): object {
  const { datasetName, levels, voxelSize, channelNames, channelColors, bits } =
    opts
  const max = maxValue(bits)
  return {
    multiscales: [
      {
        version: "0.4",
        name: datasetName,
        axes: [
          { name: "c", type: "channel" },
          { name: "z", type: "space", unit: "micrometer" },
          { name: "y", type: "space", unit: "micrometer" },
          { name: "x", type: "space", unit: "micrometer" },
        ],
        datasets: levels.map((lvl) => ({
          path: String(lvl.level),
          coordinateTransformations: [
            {
              type: "scale",
              scale: [
                1,
                voxelSize.z * lvl.factor,
                voxelSize.y * lvl.factor,
                voxelSize.x * lvl.factor,
              ],
            },
          ],
        })),
      },
    ],
    omero: {
      version: "0.4",
      channels: channelNames.map((label, i) => ({
        label,
        // omero convention: 6 hex digits, no leading "#".
        color: channelColors[i].replace(/^#/, ""),
        active: true,
        window: { min: 0, max, start: 0, end: max },
      })),
    },
  }
}

/**
 * Copy one chunk out of a source volume into `out`, zero-padding at the volume edge.
 * `out.length` must be CHUNK[0]*CHUNK[1]*CHUNK[2]. Zero-fills `out` first.
 * `strideX` is the source row length in voxels and `strideY` the source rows-per-plane;
 * for level 0 these are the PADDED extents (padX/padY) so the copy crops padding for
 * free, and for later levels they equal size.x/size.y.
 * Copies contiguous x-runs, which is the only fast way to do this.
 */
export function gatherChunk<T extends Uint8Array | Uint16Array>(
  src: T,
  size: Vec3,
  strideX: number,
  strideY: number,
  chunkZ: number,
  chunkY: number,
  chunkX: number,
  out: T
): void {
  out.fill(0)
  const [CZ, CY, CX] = CHUNK
  const baseX = chunkX * CX
  // Nothing in this chunk's x-range overlaps the volume at all.
  const runLen = Math.min(CX, size.x - baseX)
  if (runLen <= 0) return
  for (let z = 0; z < CZ; z++) {
    const srcZ = chunkZ * CZ + z
    if (srcZ >= size.z) break
    for (let y = 0; y < CY; y++) {
      const srcY = chunkY * CY + y
      if (srcY >= size.y) break
      const srcOffset = (srcZ * strideY + srcY) * strideX + baseX
      const outOffset = (z * CY + y) * CX
      // out and src share the same element type, so a plain typed-array `set`
      // is the fast path -- no per-voxel loop.
      out.set(src.subarray(srcOffset, srcOffset + runLen) as T, outOffset)
    }
  }
}

/**
 * 2x box-downsample in x, y and z. Averages the 2x2x2 neighbourhood, clamping at
 * odd boundaries so only in-range samples are averaged (never reads out of bounds,
 * never divides by the wrong count). Accumulate in a plain number -- a Uint16
 * accumulator would silently wrap when summing up to eight 12-bit-range samples.
 * Output is tightly packed (strideX === size.x, strideY === size.y).
 */
export function downsample2x<T extends Uint8Array | Uint16Array>(
  src: T,
  size: Vec3,
  strideX: number,
  strideY: number
): { data: T; size: Vec3 } {
  const outSize: Vec3 = {
    x: Math.max(1, Math.ceil(size.x / 2)),
    y: Math.max(1, Math.ceil(size.y / 2)),
    z: Math.max(1, Math.ceil(size.z / 2)),
  }
  const data = (
    src instanceof Uint8Array
      ? new Uint8Array(outSize.x * outSize.y * outSize.z)
      : new Uint16Array(outSize.x * outSize.y * outSize.z)
  ) as T

  for (let oz = 0; oz < outSize.z; oz++) {
    const z0 = oz * 2
    const zs = z0 + 1 < size.z ? [z0, z0 + 1] : [z0]
    for (let oy = 0; oy < outSize.y; oy++) {
      const y0 = oy * 2
      const ys = y0 + 1 < size.y ? [y0, y0 + 1] : [y0]
      for (let ox = 0; ox < outSize.x; ox++) {
        const x0 = ox * 2
        const xs = x0 + 1 < size.x ? [x0, x0 + 1] : [x0]
        let sum = 0
        for (const z of zs) {
          for (const y of ys) {
            const rowBase = (z * strideY + y) * strideX
            for (const x of xs) {
              sum += src[rowBase + x]
            }
          }
        }
        const count = zs.length * ys.length * xs.length
        data[(oz * outSize.y + oy) * outSize.x + ox] = Math.round(sum / count)
      }
    }
  }

  return { data, size: outSize }
}

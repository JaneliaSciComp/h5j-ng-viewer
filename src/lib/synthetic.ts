// A synthetic volume that exercises the whole ingest path -- chunking, padding crop,
// pyramid, OPFS, service worker, Neuroglancer -- without needing an H5J file.
//
// This is the Milestone 2 gate: it proves the service worker actually intercepts
// Neuroglancer's chunk-worker fetches, which is the riskiest assumption in the design.
// It doubles as an axis-order check, because the shapes are deliberately asymmetric.

import { maxValue } from "@/lib/zarr"
import type { BitDepth, ResolvedDims, Vec3 } from "@/types"

/** Non-cubical on purpose, mirroring the real 256x128x64 H5J test volume. */
const SIZE: Vec3 = { x: 256, y: 128, z: 64 }

// Padding the decoded H5J buffer carries is emulated here and filled with a sentinel,
// so a broken crop shows up as an unmissable bright slab rather than a subtle offset.
const PAD_X = 264
const PAD_Y = 136

export interface SyntheticVolume {
  name: string
  dims: ResolvedDims
  data: Uint8Array | Uint16Array
}

/**
 * Builds a volume containing, at increasing intensity:
 *   - a sphere at the origin corner
 *   - a bar along +x, three quarters of the way across
 *   - a shorter, thinner bar along +y
 *   - a cylinder along z
 *
 * In the viewer the long bar must run along x and the short one along y. If they are
 * swapped, the [z][y][x] indexing assumption is wrong -- fix the indexing rather than
 * transposing the display, or every real dataset will be silently mirrored.
 */
export function syntheticVolume(bits: BitDepth): SyntheticVolume {
  const max = maxValue(bits)
  const level = (fraction: number) => Math.round(max * fraction)

  const sentinel = max
  const sphereValue = level(0.25)
  const xBarValue = level(0.45)
  const yBarValue = level(0.7)
  const cylinderValue = level(0.95)

  const data =
    bits === 16
      ? new Uint16Array(PAD_X * PAD_Y * SIZE.z)
      : new Uint8Array(PAD_X * PAD_Y * SIZE.z)
  data.fill(sentinel)

  const sphereRadius = Math.min(SIZE.x, SIZE.y, SIZE.z) / 4

  for (let z = 0; z < SIZE.z; z += 1) {
    for (let y = 0; y < SIZE.y; y += 1) {
      const row = (z * PAD_Y + y) * PAD_X
      for (let x = 0; x < SIZE.x; x += 1) {
        data[row + x] = valueAt(x, y, z, {
          sphereRadius,
          sphereValue,
          xBarValue,
          yBarValue,
          cylinderValue,
        })
      }
    }
  }

  return {
    name: "synthetic-256x128x64",
    dims: {
      size: { ...SIZE },
      padX: PAD_X,
      padY: PAD_Y,
      voxelSize: { x: 1, y: 1, z: 1 },
      warnings: [],
    },
    data,
  }
}

function valueAt(
  x: number,
  y: number,
  z: number,
  v: {
    sphereRadius: number
    sphereValue: number
    xBarValue: number
    yBarValue: number
    cylinderValue: number
  }
): number {
  if (Math.hypot(x, y, z) < v.sphereRadius) return v.sphereValue

  const midY = SIZE.y / 2
  const midZ = SIZE.z / 2

  // Long bar along +x.
  if (x < SIZE.x * 0.75 && Math.abs(y - midY) < 6 && Math.abs(z - midZ) < 6) {
    return v.xBarValue
  }

  // Shorter, thinner bar along +y. Distinguishable from the x bar by both length
  // and thickness, so a transposed volume is obvious rather than ambiguous.
  if (
    y < SIZE.y * 0.5 &&
    Math.abs(x - SIZE.x / 2) < 3 &&
    Math.abs(z - midZ) < 3
  ) {
    return v.yBarValue
  }

  // Cylinder along z, offset so it does not sit on either bar.
  if (Math.hypot(x - SIZE.x * 0.8, y - SIZE.y * 0.75) < 8) {
    return v.cylinderValue
  }

  return 0
}

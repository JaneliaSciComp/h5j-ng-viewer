// Single-pass measurement of a decoded channel, used to (a) seed Neuroglancer's
// invlerp contrast range from the real data instead of the hardcoded dtype range,
// and (b) double as the decisive diagnostic for "is the decoded data all zeros".

import type { BitDepth, Vec3 } from "@/types"
import { maxValue } from "@/lib/zarr"

export interface ChannelStats {
  min: number
  max: number
  /** Robust low end for display contrast. */
  lower: number
  /** Robust high end for display contrast. */
  upper: number
  /** Fraction of voxels that are non-zero, 0..1. */
  nonZeroFraction: number
  /** Voxels examined (the cropped volume, excluding padding). */
  voxels: number
}

/**
 * Single pass over the in-volume voxels of a decoded channel.
 * `strideX` is the source row length in voxels and `strideY` its rows-per-plane; for a
 * level-0 buffer these are the PADDED extents, so padding must NOT be counted.
 */
export function measureChannel(
  data: Uint8Array | Uint16Array,
  size: Vec3,
  strideX: number,
  strideY: number,
  bits: BitDepth
): ChannelStats {
  const top = maxValue(bits)
  const voxels = size.x * size.y * size.z
  if (voxels === 0) {
    return {
      min: 0,
      max: 0,
      lower: 0,
      upper: top,
      nonZeroFraction: 0,
      voxels: 0,
    }
  }

  // Exact histogram: the data is integer-valued and small-ranged (256 or 4096
  // bins), so this needs no sorting and stays a single pass.
  const hist = new Uint32Array(top + 1)
  let min = top
  let max = 0
  let nonZero = 0

  for (let z = 0; z < size.z; z++) {
    for (let y = 0; y < size.y; y++) {
      const rowBase = (z * strideY + y) * strideX
      for (let x = 0; x < size.x; x++) {
        let v = data[rowBase + x]
        // A decoder returning an out-of-range value should not crash ingest --
        // clamp into the end bins instead.
        if (v < 0) v = 0
        else if (v > top) v = top
        hist[v]++
        if (v !== 0) nonZero++
        if (v < min) min = v
        if (v > max) max = v
      }
    }
  }

  // Percentiles over ALL examined voxels, not just non-zero ones: background
  // dominates these volumes, so a plain min/max is blown out by a single hot
  // voxel, while a high percentile tracks the real signal ceiling (and a low
  // one tracks the background floor) without being derailed by outliers.
  let lower = percentile(hist, voxels, 0.001)
  let upper = percentile(hist, voxels, 0.999)

  // A zero-width invlerp range makes Neuroglancer render nothing, so a constant
  // or near-constant volume (where the percentiles coincide) must never produce
  // one -- fall back to min/max, and if those also coincide, the full dtype range.
  if (upper <= lower) {
    lower = min
    upper = max
  }
  if (upper <= lower) {
    lower = 0
    upper = top
  }

  return { min, max, lower, upper, nonZeroFraction: nonZero / voxels, voxels }
}

/** Nearest-rank percentile from an exact histogram: smallest bin whose cumulative
 * count exceeds `p * voxels`. */
function percentile(hist: Uint32Array, voxels: number, p: number): number {
  const target = p * voxels
  let cumulative = 0
  for (let v = 0; v < hist.length; v++) {
    cumulative += hist[v]
    if (cumulative > target) return v
  }
  return hist.length - 1
}

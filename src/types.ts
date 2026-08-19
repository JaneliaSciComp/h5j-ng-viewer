// Shared contract between the H5J reader, the ingest worker, the zarr writer and the
// viewer-state builder. Nothing here has behaviour; see src/lib/* for that.

/** Voxel bit depth requested from the H5J loader. */
export type BitDepth = 8 | 16

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Metadata for one channel of an H5J container. */
export interface ChannelInfo {
  name: string
  contentType?: string
}

/**
 * What `getH5JAttrs` tells us before any channel has been decoded. The nominal size
 * is not authoritative -- H5J `frames` can disagree with the decoded data, and the
 * decoded buffer carries macroblock padding. `resolveDims` settles it.
 */
export interface H5JInfo {
  channels: ChannelInfo[]
  /** Nominal voxel counts from `Channels` attrs (width, height, frames). */
  nominalSize: Vec3
  /** Voxel size in micrometers, or undefined when absent or zero. */
  voxelSize?: Vec3
  /** e.g. "r", "rgb", "sgr" -- drives default channel colours. */
  channelSpec?: string
  /** Physical unit reported by the file, e.g. "micron". */
  unit?: string
  /** Raw attrs, retained for diagnostics only. */
  attrs: Record<string, unknown>
}

/**
 * Volume geometry reconciled against the decoded byte length.
 *
 * `size` is the true volume written to zarr. `padX`/`padY` are the decoded buffer's
 * x and y extents, which are >= `size.x`/`size.y` because H.265 requires aligned
 * frames; the chunk gather uses them as strides and crops to `size`.
 */
export interface ResolvedDims {
  size: Vec3
  padX: number
  padY: number
  /** Voxel size in micrometers. Defaults to 1,1,1 with a warning when unknown. */
  voxelSize: Vec3
  /** Human-readable notes to surface in the UI. Empty when everything reconciled. */
  warnings: string[]
}

/** Geometry of one pyramid level. */
export interface LevelInfo {
  /** 0 is full resolution. */
  level: number
  size: Vec3
  /** Chunk-grid extent as [z, y, x]. */
  grid: [number, number, number]
  /** Downsample factor relative to level 0, i.e. 2 ** level. */
  factor: number
}

/**
 * Written to `<level>/index.json` so the service worker can turn a zarr chunk key
 * into a byte offset without holding any ingest-derived state.
 */
export interface LevelIndex {
  /** Chunk-grid extent as [z, y, x]. */
  grid: [number, number, number]
  /** Uncompressed size of one chunk, which is also its stride in the packed file. */
  chunkBytes: number
}

export type IngestPhase = "chunking" | "downsampling" | "writing" | "done"

/** Main thread -> ingest worker. `data` is transferred, not copied. */
export interface IngestRequest {
  datasetId: string
  datasetName: string
  /** Index of this channel on the zarr `c` axis. */
  channelIndex: number
  /** Total length of the `c` axis, i.e. how many channels the user selected. */
  channelCount: number
  /** Names of all selected channels, in `c`-axis order. */
  channelNames: string[]
  /** CSS colours for all selected channels, in `c`-axis order. */
  channelColors: string[]
  bits: BitDepth
  dims: ResolvedDims
  /** Decoded voxels for this channel, padded, in [z][y][x] order with x fastest. */
  data: ArrayBuffer
}

/** Ingest worker -> main thread. */
export type IngestMessage =
  | { type: "phase"; phase: IngestPhase; level: number; levelCount: number }
  | { type: "progress"; fraction: number }
  | { type: "levelReady"; level: number }
  | { type: "done"; levels: LevelInfo[] }
  | { type: "error"; message: string }

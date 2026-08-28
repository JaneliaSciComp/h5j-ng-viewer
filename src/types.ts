// Shared contract between the H5J reader, the ingest worker, the zarr writer and the
// viewer-state builder. Nothing here has behavior; see src/lib/* for that.

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
  /** e.g. "r", "rgb", "sgr" -- drives default channel colors. */
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

/**
 * What the user can change about the rendering. Everything here is per channel, indexed
 * by the channel's own position on the `c` axis so hiding or recoloring one never shifts
 * another -- except `volumeRendering`, which is one choice about the whole view and lives
 * here rather than in `ui` because it IS a rendering property.
 *
 * This is the single source of truth the layers are derived from: a late-arriving
 * measurement must be folded into it rather than rebuilt around it, or it would discard
 * whatever the user has changed meanwhile.
 */
export interface ChannelControls {
  visible: boolean[]
  /** CSS hex, e.g. "#ff00ff". */
  colors: string[]
  /** 0..1. */
  opacity: number[]
  /** Measured display range per channel; a hole falls back to the dtype range. */
  contrast: Array<[number, number] | undefined>
  /**
   * Whether the 3D panel shows a projection of the volume rather than only the
   * cross-section planes. Off by default: it raycasts, and the cost is worth paying only
   * when asked for.
   */
  volumeRendering: boolean
  /**
   * Samples along each ray of that projection, which is also what picks the pyramid
   * level it reads. Higher is finer and costs proportionally more. See
   * `lib/projection.ts` for the ladder of allowed values.
   */
  projectionSamples: number
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
  /** Which channel this run converts. Its array is `c<channelIndex>` in the dataset. */
  channelIndex: number
  /** Name for this channel's volume, shown on the Neuroglancer layer. */
  channelName: string
  /** Its rendering color, recorded in the omero metadata. */
  channelColor: string
  bits: BitDepth
  dims: ResolvedDims
  /** Decoded voxels for this channel, padded, in [z][y][x] order with x fastest. */
  data: ArrayBuffer
}

/** Ingest worker -> main thread. */
export type IngestMessage =
  | {
      type: "stats"
      channelIndex: number
      /** Measured intensity statistics for this channel's level-0 data. */
      stats: import("@/lib/stats").ChannelStats
    }
  | { type: "phase"; phase: IngestPhase; level: number; levelCount: number }
  | { type: "progress"; fraction: number }
  | { type: "levelReady"; level: number }
  | { type: "done"; levels: LevelInfo[] }
  | { type: "error"; message: string }

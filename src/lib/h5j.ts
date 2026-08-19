// H5J ingestion: open the container, read its attrs into a typed H5JInfo, decode a
// channel through ffmpeg.wasm, and reconcile the nominal geometry against what the
// decoder actually produced. See notes/implementation-plan.md section 0 (F6-F12) and
// section 4 for the background this file implements.

import type {
  BitDepth,
  ChannelInfo,
  H5JInfo,
  ResolvedDims,
  Vec3,
} from "@/types"
import {
  getH5JAttrs,
  openH5J,
  readH5JChannelUint16,
  readH5JChannelUint8,
} from "@janelia/web-h5j-loader"
import type { FFmpegInstance, H5JFile } from "@janelia/web-h5j-loader"
import { createFFmpeg } from "@ffmpeg/ffmpeg"

// ---------------------------------------------------------------------------
// ffmpeg instance
// ---------------------------------------------------------------------------

let ffmpegPromise: Promise<FFmpegInstance> | undefined

/**
 * Memoised ffmpeg.wasm instance, loaded once and reused across channels/files
 * (F6: init takes ~1s, and decoding must happen on the main thread anyway).
 *
 * `corePath` MUST be the vendored `/ffmpeg-core/ffmpeg-core.js` (copied into
 * `public/` by vite-plugin-static-copy), not the library's own
 * `createFFmpegForEnv`, which hardcodes a unpkg.com corePath that COEP
 * `require-corp` blocks (F7).
 */
export function getFFmpeg(): Promise<FFmpegInstance> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = createFFmpeg({
        corePath: "/ffmpeg-core/ffmpeg-core.js",
        log: false,
      })
      await ffmpeg.load()
      return ffmpeg
    })()
  }
  return ffmpegPromise
}

// ---------------------------------------------------------------------------
// attrs normalisation
// ---------------------------------------------------------------------------

// jsfive hands back the same logical attribute as a plain number, a plain array,
// or a typed array depending on the HDF5 storage class, so every numeric read
// below goes through these instead of trusting a single shape.
function toNumberArray(value: unknown): number[] {
  if (value === undefined || value === null) return []
  if (typeof value === "number") return [value]
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>)
  }
  if (Array.isArray(value)) return value as number[]
  return []
}

function firstNumber(value: unknown, fallback: number): number {
  const arr = toNumberArray(value)
  return arr.length > 0 ? arr[0] : fallback
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

// ---------------------------------------------------------------------------
// parseH5JInfo
// ---------------------------------------------------------------------------

/** Pure: turn raw H5J attrs (as returned by `getH5JAttrs`) into an H5JInfo. */
export function parseH5JInfo(attrs: Record<string, unknown>): H5JInfo {
  const channelsAttrs =
    (attrs.channels as Record<string, unknown> | undefined) ?? {}

  const names = toStringArray(channelsAttrs.names)
  const contentTypesRaw = channelsAttrs.content_types
  const contentTypes: (string | undefined)[] = Array.isArray(contentTypesRaw)
    ? contentTypesRaw.map((c) =>
        c === undefined || c === null ? undefined : String(c)
      )
    : []
  const channels: ChannelInfo[] = names.map((name, i) => ({
    name,
    contentType: contentTypes[i],
  }))

  // `Channels` attrs (width/height/frames) are the authoritative nominal size.
  // `image_size` is only a size fallback when those are absent -- it is NOT a
  // valid voxel-size fallback (F10: image_size is voxel counts, so dividing it
  // by the voxel counts always yields 1).
  const imageSize = toNumberArray(attrs.image_size)
  const nominalSize: Vec3 = {
    x: firstNumber(channelsAttrs.width, imageSize[0] ?? 0),
    y: firstNumber(channelsAttrs.height, imageSize[1] ?? 0),
    z: firstNumber(channelsAttrs.frames, imageSize[2] ?? 0),
  }

  const voxelSizeArr = toNumberArray(attrs.voxel_size)
  const isValidVoxelSize =
    voxelSizeArr.length === 3 &&
    voxelSizeArr.every((v) => Number.isFinite(v) && v !== 0)
  const voxelSize: Vec3 | undefined = isValidVoxelSize
    ? { x: voxelSizeArr[0], y: voxelSizeArr[1], z: voxelSizeArr[2] }
    : undefined

  return {
    channels,
    nominalSize,
    voxelSize,
    channelSpec:
      typeof attrs.channel_spec === "string" ? attrs.channel_spec : undefined,
    unit: typeof attrs.unit === "string" ? attrs.unit : undefined,
    attrs,
  }
}

// ---------------------------------------------------------------------------
// openSource
// ---------------------------------------------------------------------------

export async function openSource(
  src: File | string
): Promise<{ file: H5JFile; info: H5JInfo }> {
  // F12: openH5J checks `src instanceof global.File`; vite.config.ts defines
  // `global` as `globalThis` so a real File instance satisfies that check.
  const file = await openH5J(src)
  const attrs = getH5JAttrs(file) ?? {}
  return { file, info: parseH5JInfo(attrs) }
}

// ---------------------------------------------------------------------------
// resolveDims
// ---------------------------------------------------------------------------

/**
 * Pure: reconcile the nominal H5J geometry against how many voxels actually came
 * back from the decoder. The decoded buffer is padded to a macroblock-aligned
 * width/height (H.265 needs aligned frames) and the nominal `frames` count can
 * simply be wrong, so neither is trusted -- both are re-derived from
 * `decodedVoxelCount`. See notes/implementation-plan.md section 4.
 */
export function resolveDims(
  info: H5JInfo,
  decodedVoxelCount: number
): ResolvedDims {
  const warnings: string[] = []
  const trueW = info.nominalSize.x
  const trueH = info.nominalSize.y

  const channelsAttrs =
    (info.attrs.channels as Record<string, unknown> | undefined) ?? {}
  const padRight = firstNumber(channelsAttrs.pad_right, 0)
  const padBottom = firstNumber(channelsAttrs.pad_bottom, 0)

  // Candidate padded extents, most trustworthy first:
  //   1. The file's declared padding -- but only when it actually declares some.
  //      A pad_right/pad_bottom of 0 is indistinguishable from "not recorded", and
  //      admitting it as a candidate would preempt the alignment rule below with a
  //      claim of "no padding" that the encoder cannot have honoured.
  //   2. The H.265 macroblock alignment rule: round up to a multiple of 8. This is
  //      what the decoder actually emits; web-vol-viewer relies on it in production.
  //   3. No padding at all, as a last resort in case the alignment is not 8.
  const pairs: Array<[number, number]> = []
  const addPair = (w: number, h: number) => {
    if (w > 0 && h > 0 && !pairs.some(([pw, ph]) => pw === w && ph === h)) {
      pairs.push([w, h])
    }
  }
  if (padRight > 0 || padBottom > 0)
    addPair(trueW + padRight, trueH + padBottom)
  addPair(Math.ceil(trueW / 8) * 8, Math.ceil(trueH / 8) * 8)
  addPair(trueW, trueH)

  // Divisibility alone is too weak to identify the layout. For many realistic
  // width/height pairs the *unpadded* area also divides the padded voxel count, just
  // yielding a different and wrong frame count -- e.g. a 100x156 volume padded to
  // 104x160 with 15 frames decodes to 249600 voxels, which 100*156 divides exactly,
  // giving 16 frames and a row stride 4 short. That misreads every row after the
  // first, shearing the volume rather than failing. So consider every candidate that
  // fits and break the tie with the nominal frame count, which F8 makes a hint rather
  // than an authority; priority order decides when the hint is absent or unhelpful.
  const fits = pairs
    .map(([padW, padH]) => ({
      padW,
      padH,
      nZ: decodedVoxelCount / (padW * padH),
    }))
    .filter((candidate) => Number.isInteger(candidate.nZ) && candidate.nZ > 0)

  let chosen = fits[0]
  if (chosen && info.nominalSize.z > 0) {
    for (const candidate of fits) {
      const closer =
        Math.abs(candidate.nZ - info.nominalSize.z) <
        Math.abs(chosen.nZ - info.nominalSize.z)
      if (closer) chosen = candidate
    }
  }

  if (!chosen) {
    throw new Error(
      `resolveDims: decodedVoxelCount=${decodedVoxelCount} does not fit nominal size ` +
        `${trueW}x${trueH} against any padding candidate (tried ${pairs
          .map(([w, h]) => `${w}x${h}`)
          .join(", ")})`
    )
  }

  if (info.nominalSize.z > 0 && chosen.nZ !== info.nominalSize.z) {
    warnings.push(
      `Decoded frame count (${chosen.nZ}) disagrees with the file's nominal frame count ` +
        `(${info.nominalSize.z}); using the decoded value.`
    )
  }

  if (chosen.padW > trueW || chosen.padH > trueH) {
    warnings.push(
      `Decoded frames are padded to ${chosen.padW}x${chosen.padH} ` +
        `(nominal size is ${trueW}x${trueH}); the padding will be cropped.`
    )
  }

  // A wrong voxel size renders a volume that "works" but is silently squashed
  // or stretched, which is a more confusing failure than an obviously-wrong
  // one -- so this always warns rather than failing silently.
  let voxelSize = info.voxelSize
  if (!voxelSize) {
    voxelSize = { x: 1, y: 1, z: 1 }
    warnings.push(
      "voxel_size is missing or invalid; defaulting to 1,1,1 micrometers " +
        "(the volume will render at the wrong physical scale)."
    )
  }

  return {
    size: { x: trueW, y: trueH, z: chosen.nZ },
    padX: chosen.padW,
    padY: chosen.padH,
    voxelSize,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// decodeChannel
// ---------------------------------------------------------------------------

/** Decode one channel. Progress ratio 0..1 comes from ffmpeg. */
export async function decodeChannel(
  file: H5JFile,
  channelName: string,
  bits: BitDepth,
  onProgress?: (ratio: number) => void
): Promise<Uint8Array | Uint16Array> {
  const ffmpeg = await getFFmpeg()
  const progressAdapter = onProgress
    ? ({ ratio }: { ratio: number }) => onProgress(ratio)
    : undefined

  // F11: the 16-bit path returns unscaled 12-bit values (0..4095), not full
  // 16-bit range -- callers (the ingest worker / shader) must use that range.
  const data =
    bits === 16
      ? await readH5JChannelUint16(channelName, file, progressAdapter, ffmpeg)
      : await readH5JChannelUint8(channelName, file, progressAdapter, ffmpeg)

  // The library returns null on internal failure instead of throwing.
  if (!data) {
    throw new Error(`decodeChannel: failed to decode channel "${channelName}"`)
  }
  return data
}

// ---------------------------------------------------------------------------
// defaultChannelColors
// ---------------------------------------------------------------------------

const SPEC_COLORS: Record<string, string> = {
  r: "#ff0000",
  g: "#00ff00",
  b: "#0000ff",
  c: "#00ffff",
  m: "#ff00ff",
  y: "#ffff00",
  w: "#ffffff",
  s: "#ffffff", // reference/structural channel
}

// Used whenever channel_spec is missing, too short, or has an unrecognised
// character at a given index -- cycles if there are more channels than colours.
const FALLBACK_PALETTE = ["#ff00ff", "#00ff00", "#00ffff", "#ffffff"]

/** Pure: default CSS hex colours per channel, from `channel_spec` when usable. */
export function defaultChannelColors(
  channelSpec: string | undefined,
  count: number
): string[] {
  const colors: string[] = []
  for (let i = 0; i < count; i++) {
    const specChar = channelSpec?.[i]?.toLowerCase()
    const specColor = specChar ? SPEC_COLORS[specChar] : undefined
    colors.push(specColor ?? FALLBACK_PALETTE[i % FALLBACK_PALETTE.length])
  }
  return colors
}

// ---------------------------------------------------------------------------
// projectedOutputBytes
// ---------------------------------------------------------------------------

// Pyramid levels (2x downsample in x/y/z) add roughly 1/8 + 1/64 + ... on top
// of level 0; the plan's memory-guard heuristic rounds that overhead up
// generously to 33% to stay conservative for the pre-decode quota warning.
const PYRAMID_OVERHEAD = 1.33

/** Projected output bytes including pyramid overhead, for the pre-decode quota warning. */
export function projectedOutputBytes(
  size: Vec3,
  channelCount: number,
  bits: BitDepth
): number {
  const bytesPerVoxel = bits === 16 ? 2 : 1
  return (
    size.x * size.y * size.z * channelCount * bytesPerVoxel * PYRAMID_OVERHEAD
  )
}

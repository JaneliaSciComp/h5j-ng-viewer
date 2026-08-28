// The load pipeline: decode each channel on the main thread, hand it to the ingest
// worker for chunking, and report progress by dispatching actions.
//
// This lives outside the components because it is a long, sequential process with no
// UI of its own, and because it can then be driven directly from a test with a fake
// dispatch. It never imports React.
//
// The decode/chunk split is forced: ffmpeg.wasm 0.10 injects a <script> tag and so
// needs a document, while `createSyncAccessHandle()` -- the fast OPFS write path -- is
// worker-only. So decoding happens here and chunking happens in ingest.worker.ts, with
// the decoded buffer transferred rather than copied.

import { decodeChannel, resolveDims, VOXEL_BITS } from "@/lib/h5j"
import { buildViewerState } from "@/lib/ngstate"
import {
  buildZarray,
  buildZattrs,
  buildZgroup,
  chunkBytes,
  pyramid,
} from "@/lib/zarr"
import { writeJson } from "@/lib/opfs"
import { levelIndexPath, zarrayPath, zattrsPath, zgroupPath } from "@/lib/paths"
import { describeProbe, probeDataset } from "@/lib/verify"
import {
  channelReady,
  ingestChannel,
  ingestDetails,
  ingestDims,
  ingestDone,
  ingestFailed,
  ingestPhase,
  ingestProgress,
  ingestStarted,
  ingestStats,
  ingestWarnings,
  viewerReady,
} from "@/state/actions"
import type { Dispatch } from "@/state/actions"
import type { ChannelStats } from "@/lib/stats"
import type {
  ChannelControls,
  H5JInfo,
  IngestMessage,
  IngestRequest,
  ResolvedDims,
  Vec3,
} from "@/types"
import type { H5JFile } from "@janelia/web-h5j-loader"
import type { LaunchParams } from "@/lib/url"

export interface IngestParams {
  file: H5JFile
  info: H5JInfo
  /** Display name of the source, also the seed for the dataset id. */
  sourceName: string
  /**
   * How each channel is rendered when the viewer mounts. Passed in rather than derived
   * here, because the store owns it: the user may have changed something between the
   * first channel landing and the last.
   */
  controls: ChannelControls
  /** Origin the service worker serves the dataset from, i.e. `location.origin`. */
  origin: string
  /** Color, position and zoom overrides from the address bar. */
  launch: LaunchParams
}

/**
 * Convert EVERY channel of an open H5J container into OPFS, visible ones first,
 * mounting the viewer as soon as the first of them is readable.
 *
 * Converting everything costs storage, but it is what makes showing a channel free
 * afterwards -- no going back to the H5J and decoding again. Doing the visible ones
 * first means time-to-first-pixel is the cost of ONE channel: each channel is its own
 * zarr array behind its own layer, so the rest stream in underneath and each turns
 * visible the moment it is complete.
 *
 * Never throws: failures are reported through `dispatch` so the caller has nothing to
 * catch and the UI has a single place errors arrive from.
 */
export async function ingestH5J(
  params: IngestParams,
  dispatch: Dispatch
): Promise<void> {
  const { file, info, sourceName, controls, origin, launch } = params
  const names = info.channels.map((channel) => channel.name)
  if (names.length === 0) return

  const datasetId = makeDatasetId(sourceName)
  const datasetName = sourceName || datasetId
  const order = conversionOrder(controls.visible, names.length)

  dispatch(ingestStarted(names.length))

  // Resolved once, from the first channel, and reused. Every channel of one H5J file
  // shares the `Channels` group's width/height/frames, and the layers are blended on
  // top of each other in one coordinate space -- so letting each channel resolve its
  // own geometry would risk later channels silently disagreeing with the shape earlier
  // channels were written and are read at.
  let dims: ResolvedDims | null = null
  const stats: Array<ChannelStats | undefined> = []
  const ready = Array.from({ length: names.length }, () => false)

  try {
    for (let position = 0; position < order.length; position += 1) {
      // `index` is the channel's own position in the container, which is what names its
      // array, its layer and its controls. It is NOT the loop counter: the loop runs in
      // priority order, so the two differ as soon as a hidden channel is skipped ahead
      // of a visible one.
      const index = order[position]
      const name = names[index]
      dispatch(
        ingestChannel(index, `${name} (${position + 1} of ${order.length})`)
      )

      dispatch(ingestPhase("decoding"))
      dispatch(ingestProgress(0))
      const decoded = await decodeChannel(file, name, VOXEL_BITS, (ratio) =>
        dispatch(ingestProgress(ratio))
      )

      if (!dims) {
        dims = resolveDims(info, decoded.length)
        dispatch(ingestDims(dims))
        if (dims.warnings.length > 0) dispatch(ingestWarnings(dims.warnings))
        // Every channel's metadata, before any of them has chunks. A layer is declared
        // for each channel at mount -- including channels still converting, which are
        // simply not visible -- and a layer whose `.zattrs` 404s fails to resolve and
        // never retries. Chunks may be missing; the description may not.
        await writeAllMetadata(datasetId, names, controls.colors, dims)
      } else if (decoded.length !== dims.padX * dims.padY * dims.size.z) {
        throw new Error(
          `Channel "${name}" decoded to ${decoded.length} voxels, but ` +
            `"${names[order[0]]}" decoded to ` +
            `${dims.padX * dims.padY * dims.size.z}. ` +
            `Channels of one file must share a geometry.`
        )
      }

      const request: IngestRequest = {
        datasetId,
        channelIndex: index,
        channelName: name,
        channelColor: controls.colors[index],
        bits: VOXEL_BITS,
        dims,
        data: detachBuffer(decoded),
      }

      dispatch(ingestPhase("chunking"))
      dispatch(ingestProgress(0))
      await runIngestWorker(request, (message) => {
        if (message.type === "phase") {
          dispatch(
            ingestPhase(
              message.phase,
              message.levelCount > 1
                ? `Level ${message.level} of ${message.levelCount - 1}`
                : undefined
            )
          )
        } else if (message.type === "progress") {
          dispatch(ingestProgress(message.fraction))
        } else if (message.type === "stats") {
          stats[message.channelIndex] = message.stats
          dispatch(ingestStats(message.channelIndex, message.stats))
        }
      })

      ready[index] = true
      dispatch(channelReady(index))

      if (position === 0) {
        // The viewer mounts on the FIRST readable channel, not the last: waiting for
        // every channel would mean staring at nothing for the whole conversion of a
        // multi-channel file. Every channel gets its layer here, including the ones
        // still converting -- a layer whose `.zattrs` 404s fails to resolve and never
        // retries, so they cannot be added later -- and each one is not visible until
        // its own data exists, which is what stops a half-written channel from being
        // read. Contrast for the later channels arrives afterwards as a shader-control
        // update on the live layer.
        dispatch(
          viewerReady(
            datasetId,
            JSON.stringify(
              buildViewerState({
                controls: {
                  ...controls,
                  contrast: contrastRanges(stats, names.length),
                },
                dataset: {
                  origin,
                  datasetId,
                  datasetName,
                  voxelSize: dims.voxelSize,
                  bits: VOXEL_BITS,
                  channelNames: names,
                  ready: [...ready],
                },
                size: dims.size,
                position: launch.position ?? undefined,
                crossSectionScale: launch.zoom ?? undefined,
              })
            ),
            describeGeometry(dims.size, names.length)
          )
        )
      }

      const measured = stats[index]
      if (measured) {
        // Surfaced because an all-zero channel and a correctly-converted but dim one
        // look identical in the viewer.
        dispatch(
          ingestDetails([
            `${name}: ${measured.min}–${measured.max}, ` +
              `display ${measured.lower}–${measured.upper}, ` +
              `${(measured.nonZeroFraction * 100).toFixed(1)}% non-zero`,
          ])
        )
        if (measured.max === 0) {
          dispatch(
            ingestWarnings([
              `Channel "${name}" decoded to all zeros, so it will render as nothing.`,
            ])
          )
        }
      }
    }

    if (!dims) throw new Error("No channel produced a geometry")

    // Probe the finished dataset over HTTP, exactly as Neuroglancer will. A level
    // whose chunks 404 renders as empty black with no error, and chunk-worker requests
    // are not reliably visible in the network panel, so without this the failure is
    // indistinguishable from "the data is just dark".
    const probe = await probeDataset(origin, datasetId, names.length)
    dispatch(ingestDetails(describeProbe(probe)))
    if (probe.problems.length > 0) dispatch(ingestWarnings(probe.problems))

    dispatch(ingestDone())
  } catch (exc) {
    dispatch(ingestFailed(exc instanceof Error ? exc.message : String(exc)))
  }
}

/**
 * Run one channel through the ingest worker. A fresh worker per channel keeps the
 * message protocol a plain request/response with no routing state, and guarantees the
 * decoded buffer is released when the worker is terminated.
 */
function runIngestWorker(
  request: IngestRequest,
  onMessage: (message: IngestMessage) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../ingest.worker.ts", import.meta.url), {
      type: "module",
    })
    const finish = (settle: () => void) => {
      worker.terminate()
      settle()
    }
    worker.onmessage = (event: MessageEvent<IngestMessage>) => {
      const message = event.data
      onMessage(message)
      if (message.type === "done") finish(resolve)
      else if (message.type === "error")
        finish(() => reject(new Error(message.message)))
    }
    worker.onerror = (event) =>
      finish(() => reject(new Error(event.message || "Ingest worker failed")))
    worker.postMessage(request, [request.data])
  })
}

/**
 * Hand the decoder's output to the worker as a transferable ArrayBuffer. ffmpeg's
 * emscripten FS may return a view into a larger buffer, in which case transferring the
 * whole buffer would move more than we own -- copy in that case.
 */
export function detachBuffer(array: Uint8Array | Uint16Array): ArrayBuffer {
  const exact =
    array.byteOffset === 0 && array.byteLength === array.buffer.byteLength
  return exact
    ? (array.buffer as ArrayBuffer)
    : (array.slice().buffer as ArrayBuffer)
}

/**
 * Describe every channel up front: the group, the multiscale metadata, and one `.zarray`
 * plus index per level. Cheap -- a few small JSON documents per channel -- and it has to
 * happen before the viewer mounts, because Neuroglancer resolves a layer's metadata even
 * when the layer is not visible.
 */
async function writeAllMetadata(
  datasetId: string,
  names: string[],
  colors: string[],
  dims: ResolvedDims
): Promise<void> {
  const levels = pyramid(dims.size)
  for (let channel = 0; channel < names.length; channel += 1) {
    await writeJson(zgroupPath(datasetId, channel), buildZgroup())
    await writeJson(
      zattrsPath(datasetId, channel),
      buildZattrs({
        name: names[channel],
        levels,
        voxelSize: dims.voxelSize,
        color: colors[channel],
        bits: VOXEL_BITS,
      })
    )
    for (const level of levels) {
      await writeJson(
        zarrayPath(datasetId, channel, level.level),
        buildZarray(level.size, VOXEL_BITS)
      )
      await writeJson(levelIndexPath(datasetId, channel, level.level), {
        grid: level.grid,
        chunkBytes: chunkBytes(VOXEL_BITS),
      })
    }
  }
}

/**
 * The order channels are converted in: visible ones first, then the rest. Both groups
 * keep container order, so the sequence is predictable rather than merely correct.
 */
export function conversionOrder(
  visible: boolean[],
  channelCount: number
): number[] {
  const all = Array.from({ length: channelCount }, (_, index) => index)
  const shown = all.filter((index) => visible[index] !== false)
  const hidden = all.filter((index) => visible[index] === false)
  return [...shown, ...hidden]
}

/**
 * Overlay the address bar's colors on the defaults. A null entry means "no override
 * for this channel", so the positions of the remaining overrides are preserved even
 * when one of them is missing or malformed.
 */
export function applyColorOverrides(
  defaults: string[],
  overrides: Array<string | null> | null
): string[] {
  if (!overrides) return defaults
  return defaults.map((color, index) => overrides[index] ?? color)
}

/**
 * Per-channel display ranges from the measured statistics, in c-axis order. Channels
 * still being ingested get no entry, so buildViewerState falls back to the dtype range
 * for them rather than inventing a window.
 */
export function contrastRanges(
  stats: Array<ChannelStats | undefined>,
  count: number
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < count; index += 1) {
    const measured = stats[index]
    if (measured && measured.upper > measured.lower) {
      ranges[index] = [measured.lower, measured.upper]
    }
  }
  return ranges
}

/** One-line geometry summary for the top bar. */
export function describeGeometry(size: Vec3, channelCount: number): string {
  return (
    `${size.x}×${size.y}×${size.z}, ` +
    `${channelCount} channel${channelCount === 1 ? "" : "s"}, ${VOXEL_BITS}-bit`
  )
}

/**
 * Dataset id, and therefore the OPFS directory name. The timestamp suffix will become
 * a hash of the source URL and its validator, so that reloading the same file reuses
 * the conversion instead of storing a second copy of it.
 */
export function makeDatasetId(sourceName: string): string {
  const base =
    sourceName
      .replace(/^.*[/\\]/, "")
      .replace(/\.h5j$/i, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 60) || "volume"
  return `${base}-${Date.now().toString(36)}`
}

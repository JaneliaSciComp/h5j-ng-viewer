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

import {
  decodeChannel,
  projectedOutputBytes,
  resolveDims,
  VOXEL_BITS,
} from "@/lib/h5j"
import { buildViewerState } from "@/lib/ngstate"
import {
  buildZarray,
  buildZattrs,
  buildZgroup,
  chunkBytes,
  pyramid,
} from "@/lib/zarr"
import { formatBytes } from "@/lib/bytes"
import {
  describeStorage,
  formatEnvironment,
  readEnvironment,
} from "@/lib/environment"
import { evictDatasets, listDatasetRecords, markComplete } from "@/lib/datasets"
import type { DatasetMarker } from "@/lib/datasets"
import { applyPlan, planEviction } from "@/lib/evict"
import { removeDataset, storageEstimate, writeJson } from "@/lib/opfs"
import { LAYOUT_VERSION } from "@/lib/paths"
import { storageBudget } from "@/lib/prefs"
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
import type { Action, Dispatch } from "@/state/actions"
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
  /** How full storage may get before old volumes are evicted to make room. */
  evictionPercent: number
  /** Color, position and zoom overrides from the address bar. */
  launch: LaunchParams
  /** Where this file came from, recorded with the dataset. Null for a dropped file. */
  sourceUrl: string | null
  /**
   * The dataset the viewer is currently mounted on, if any. Never evicted: its chunks
   * are being served to Neuroglancer right now, and removing it under a live layer
   * turns a working view black with no error anywhere.
   */
  mountedDatasetId: string | null
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
  const { sourceUrl, mountedDatasetId, evictionPercent } = params
  const names = info.channels.map((channel) => channel.name)
  if (names.length === 0) return

  // The full URL, not the basename the bar shows: the basename has had its path
  // stripped, so two folders holding a file of the same name would produce one key.
  const datasetId = makeDatasetId(sourceName, sourceUrl ?? sourceName)
  const datasetName = sourceName || datasetId
  const order = conversionOrder(controls.visible, names.length)

  dispatch(ingestStarted(names.length))

  // Checked before a byte is written, because the alternative is discovering it halfway
  // through: the write fails, and what has been written so far is an unreadable tree
  // that has to be cleaned up. Advisory rather than exact -- the browser's quota is a
  // fraction of FREE disk and shrinks as the disk fills, so it can still be exceeded
  // partway through a conversion that fitted when it started. Catching the clear cases
  // is worth it even so.
  const projected = projectedOutputBytes(
    info.nominalSize,
    names.length,
    VOXEL_BITS
  )
  const shortfall = await makeRoom({
    needed: projected,
    keep: [datasetId, mountedDatasetId].filter(
      (id): id is string => id !== null
    ),
    evictionPercent,
    dispatch,
  })
  if (shortfall) {
    dispatch(ingestFailed(shortfall))
    return
  }

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
        if (dims.notes.length > 0) dispatch(ingestDetails(dims.notes))
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
          mountAction({
            datasetId,
            datasetName,
            origin,
            controls,
            launch,
            dims,
            stats,
            names,
            ready,
          })
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

    // Last, after every chunk: the marker's presence is what says this dataset can be
    // viewed, so writing it earlier would make a run that died halfway look finished.
    // A failure to write it is not a failure of the conversion -- it only means this
    // dataset looks like debris to eviction and goes early.
    await markComplete({
      datasetId,
      name: datasetName,
      sourceUrl: sourceUrl ?? null,
      now: Date.now(),
      info,
      dims,
      stats,
    }).catch(() => undefined)

    dispatch(ingestDone())
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc)

    // Gathered here, at the moment of failure, not when Settings is next opened: the
    // quota moves, and a figure read minutes later describes a different situation from
    // the one that broke. Interpreted as well as reported -- "8 KB of 10 GB used" beside
    // "no space available" is a contradiction a reader should not have to resolve.
    const env = await readEnvironment().catch(() => null)
    if (env) {
      dispatch(
        ingestDetails([
          ...describeStorage(env.storage, bytesWrittenFrom(message)),
          formatEnvironment(env),
        ])
      )
    }

    // A failure that wrote nothing readable leaves a tree that no layer can resolve and
    // nothing will ever list -- pure consumed space. Removing it matters most for the
    // failure that is most likely: running out of room. Leaving the debris behind makes
    // the NEXT conversion likelier to fail for the same reason, which is how one full
    // disk turns into a run of failures.
    //
    // Only when nothing became readable, though. Once a channel has landed the viewer
    // has mounted on it and is serving its chunks; deleting the tree under a live layer
    // would replace a partial success with a broken one.
    if (!ready.some(Boolean)) {
      try {
        await removeDataset(datasetId)
      } catch {
        // Reporting the original failure matters more than reporting a failure to tidy
        // up after it.
      }
      dispatch(ingestFailed(message))
    } else {
      const done = ready.filter(Boolean).length
      dispatch(
        ingestFailed(
          `${message} (${done} of ${names.length} channels converted before this ` +
            `failed; what converted is still viewable, and the rest can be reclaimed ` +
            `from Settings)`
        )
      )
    }
  }
}

/**
 * Show a volume that has already been converted, without opening the H5J at all.
 *
 * Returns true when it mounted. The whole point is what it skips: no download of a file
 * that can run to hundreds of megabytes, no ffmpeg, no chunking, no pyramid. The marker
 * carries the geometry and the measured contrast, which are the only things the mount
 * needed the file for.
 *
 * It probes over HTTP before committing. A tree can be present but unservable -- a
 * partial delete, a level whose chunks never landed -- and zarr reads a missing chunk as
 * fill_value, so the failure would be a silently black volume rather than an error. The
 * probe is a few requests against data already on disk; a wrong reuse costs the user a
 * volume that looks empty for no visible reason.
 */
export async function reuseDataset(
  opts: {
    marker: DatasetMarker
    controls: ChannelControls
    origin: string
    launch: LaunchParams
  },
  dispatch: Dispatch
): Promise<boolean> {
  const { marker, controls, origin, launch } = opts
  const names = marker.info.channels.map((channel) => channel.name)

  const probe = await probeDataset(origin, marker.id, names.length).catch(
    () => null
  )
  if (!probe || probe.problems.length > 0) {
    // Unservable, so it is not a cache entry -- it is debris that would render black.
    // Removing it means the reconversion that follows has room, and that a second
    // attempt does not hit the same broken tree.
    await removeDataset(marker.id).catch(() => undefined)
    return false
  }

  dispatch(ingestStarted(names.length))
  dispatch(ingestDims(marker.dims))
  if (marker.dims.notes?.length) dispatch(ingestDetails(marker.dims.notes))
  marker.stats.forEach((stats, index) => {
    if (stats) dispatch(ingestStats(index, stats))
  })
  names.forEach((_, index) => dispatch(channelReady(index)))

  dispatch(
    mountAction({
      datasetId: marker.id,
      datasetName: marker.name || marker.id,
      origin,
      controls,
      launch,
      dims: marker.dims,
      stats: marker.stats,
      names,
      // Every channel is on disk, so every layer is visible from the start -- the
      // staggered reveal exists for conversion, and there is nothing to stagger here.
      ready: names.map(() => true),
    })
  )
  dispatch(ingestDetails(describeProbe(probe)))
  dispatch(ingestDone())
  return true
}

/**
 * The action that puts a dataset on screen.
 *
 * Shared by the two ways one gets there -- converted just now, or found already
 * converted -- because they must produce the same viewer. Two builders would drift, and
 * the drift would show up as a cached volume rendering differently from a fresh one,
 * which is the kind of difference nobody thinks to look for.
 */
function mountAction(opts: {
  datasetId: string
  datasetName: string
  origin: string
  controls: ChannelControls
  launch: LaunchParams
  dims: ResolvedDims
  stats: Array<ChannelStats | undefined>
  names: string[]
  ready: boolean[]
}): Action {
  return viewerReady(
    opts.datasetId,
    JSON.stringify(
      buildViewerState({
        controls: {
          ...opts.controls,
          contrast: contrastRanges(opts.stats, opts.names.length),
        },
        dataset: {
          origin: opts.origin,
          datasetId: opts.datasetId,
          datasetName: opts.datasetName,
          voxelSize: opts.dims.voxelSize,
          bits: VOXEL_BITS,
          channelNames: opts.names,
          ready: [...opts.ready],
        },
        size: opts.dims.size,
        position: opts.launch.position ?? undefined,
        crossSectionScale: opts.launch.zoom ?? undefined,
      })
    ),
    describeGeometry(opts.dims.size, opts.names.length)
  )
}

/**
 * The byte count an OPFS write failure carries, if it carries one.
 *
 * Read back out of the message rather than threaded through as a value, because the
 * throw crosses a worker boundary on its way here and only the message survives that.
 */
function bytesWrittenFrom(message: string): number | undefined {
  const match = /after (\d+) bytes/.exec(message)
  return match ? Number(match[1]) : undefined
}

/**
 * Make room for `needed` bytes, evicting least-recently-used datasets if necessary.
 *
 * Returns null when there is room, or a message explaining why there cannot be.
 *
 * The order matters: work out the whole plan first, and only carry it out if it gets
 * there. Evicting greedily until the disk runs out would in the worst case delete every
 * volume the user has and then fail anyway -- costing them everything and buying
 * nothing. Better to refuse while their data is intact and let them choose.
 */
async function makeRoom(opts: {
  needed: number
  keep: string[]
  evictionPercent: number
  dispatch: Dispatch
}): Promise<string | null> {
  const { usage, quota } = await storageEstimate().catch(() => ({
    usage: 0,
    quota: 0,
  }))
  // A browser that reports no quota tells us nothing, and refusing on no information
  // would block a conversion that might well have fitted.
  if (quota <= 0) return null

  // Free against the configured budget, not against the whole quota. That is what makes
  // eviction start at the threshold rather than at the cliff: the app keeps itself
  // inside its share, leaving the rest for other sites drawing on the same disk, and
  // leaving a conversion that runs over its projection somewhere to go.
  const budget = storageBudget(quota, opts.evictionPercent)
  const free = Math.max(0, budget - usage)
  if (opts.needed <= free) return null

  // Announced before the survey, not just before the deleting. Measuring an unmarked
  // dataset means a handle per file, so on a cache full of them the survey alone takes
  // long enough to look like a hang.
  opts.dispatch(ingestPhase("evicting", "checking what is stored"))
  opts.dispatch(ingestProgress(null))
  const records = await listDatasetRecords().catch(() => [])
  const plan = planEviction(records, {
    needed: opts.needed,
    free,
    keep: opts.keep,
  })

  const advice =
    `Open Settings to see what is stored, and to raise the storage limit if you want ` +
    `this app to use more of the browser's quota. The quota is itself a fraction of ` +
    `the machine's free disk, so freeing space on the machine raises it too.`

  if (!applyPlan(plan).length) {
    return (
      `This file needs about ${formatBytes(opts.needed)} of browser storage but only ` +
      `${formatBytes(free)} is free, and clearing older volumes would recover just ` +
      `${formatBytes(plan.reclaimed)} of that. Nothing has been deleted. ${advice}`
    )
  }

  const doomed = applyPlan(plan)
  const volumes = `${doomed.length} volume${doomed.length === 1 ? "" : "s"}`
  opts.dispatch(
    ingestPhase("evicting", `${volumes}, ${formatBytes(plan.reclaimed)}`)
  )
  opts.dispatch(ingestProgress(0))
  await evictDatasets(doomed, (done, total) => {
    opts.dispatch(
      ingestPhase(
        "evicting",
        `${volumes}, ${formatBytes(plan.reclaimed)} · ${done}/${total}`
      )
    )
    opts.dispatch(ingestProgress(total === 0 ? null : done / total))
  })
  opts.dispatch(
    ingestDetails([
      `Reclaimed ${formatBytes(plan.reclaimed)} by removing ${volumes}.`,
    ])
  )

  // Re-measured rather than assumed: a removal that silently failed, or a quota that
  // moved while we worked, both show up here rather than as a write failure partway in.
  const after = await storageEstimate().catch(() => ({ usage, quota }))
  const freeNow = Math.max(0, after.quota - after.usage)
  if (opts.needed > freeNow) {
    return (
      `This file needs about ${formatBytes(opts.needed)} of browser storage and only ` +
      `${formatBytes(freeNow)} is free after clearing older volumes. ${advice}`
    )
  }
  return null
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
/**
 * A hash of the whole source identity, as a short path-safe string.
 *
 * Two independent FNV-1a passes with different primes, giving ~64 bits. Not
 * cryptographic and does not need to be: the only requirement is that two different
 * volumes do not land on the same key, and 64 bits is far past the point where that
 * matters for a per-browser cache.
 */
function hashIdentity(identity: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < identity.length; i += 1) {
    const code = identity.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x85ebca6b)
  }
  const part = (n: number) => (n >>> 0).toString(36).padStart(7, "0")
  return part(a) + part(b)
}

/**
 * What identifies a source, for the purpose of "have we already converted this?".
 *
 * For a URL that is the URL, plus whatever the server will tell us cheaply about the
 * bytes behind it. `Content-Length` and `Last-Modified` are both CORS-safelisted, so
 * they are readable cross-origin with no cooperation from the bucket beyond the CORS it
 * already needs -- and together they answer the one question a URL alone cannot: has
 * this file been replaced since we converted it? When the HEAD fails, the URL alone is
 * still a reasonable identity; the cost of being wrong is a stale render of a file that
 * was regenerated in place, which is rare for archival data.
 *
 * For a dropped file there is no URL, so name, size and modification time stand in.
 */
const IDENTITY_HEAD_TIMEOUT_MS = 3000

export async function sourceIdentity(src: File | string): Promise<string> {
  if (typeof src !== "string") {
    return `file:${src.name}:${src.size}:${src.lastModified}`
  }
  try {
    // Bounded, because this sits in front of everything: the reuse check runs before
    // the file is opened, so a HEAD that hangs would stall the whole load with an
    // empty screen and nothing in the console. Three seconds is far longer than a
    // HEAD should take, and giving up costs only the freshness check -- the URL alone
    // is still a usable identity.
    const response = await fetch(src, {
      method: "HEAD",
      signal: AbortSignal.timeout(IDENTITY_HEAD_TIMEOUT_MS),
    })
    if (response.ok) {
      const length = response.headers.get("content-length") ?? ""
      const modified = response.headers.get("last-modified") ?? ""
      if (length || modified) return `${src}:${length}:${modified}`
    }
  } catch {
    // A server that refuses HEAD, or a network hiccup. The URL on its own still
    // identifies the file well enough to be worth caching against.
  }
  return src
}

/**
 * The directory name for one converted volume: a readable prefix and a hash of the full
 * source identity.
 *
 * Content-addressed, so loading the same file twice yields the same key and the second
 * load can mount what the first wrote. The layout version is folded in, so a build that
 * changes the on-disk format never looks at a tree written by one that did not.
 *
 * The hash is not decoration, and the prefix must never be trusted on its own. Real
 * names run past a hundred characters and differ well past any sane truncation:
 * `…-JRC2018_VNC_FEMALE_40x_DS-aligned_stack` and `…-JRC2018_VNC_Unisex_40x_DS-aligned_stack`
 * are different volumes whose first sixty characters are identical. The prefix also
 * comes from the basename, so the same filename in two different folders collides as
 * well. An elided name cannot identify a volume; the hash of the full URL can.
 *
 * The timestamp is what currently makes every load a fresh dataset. Removing it turns
 * this into a content-addressed id -- the same file yielding the same key -- which is
 * the prerequisite for reusing a conversion instead of repeating it.
 */
export function makeDatasetId(sourceName: string, identity?: string): string {
  const material = `v${LAYOUT_VERSION}/${VOXEL_BITS}/${identity ?? sourceName}`
  const cleaned = sourceName
    .replace(/^.*[/\\]/, "")
    .replace(/\.h5j$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 48)
  // Must contain something that is not punctuation. `.` and `._-` survive the filter
  // above, so a file called `..h5j` would otherwise ask for a directory named `.` --
  // and a truthiness check does not catch that, because "." is truthy.
  const base = /[a-zA-Z0-9]/.test(cleaned) ? cleaned : "volume"
  return `${base}-${hashIdentity(material)}`
}

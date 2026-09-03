// The dataset marker: what is on disk, how big it is, and when it was last opened.
//
// This is the state LRU eviction runs on, and it has to survive a reload -- "least
// recently used" cannot be reconstructed from the chunks themselves, so it is written
// down. The policy that consumes these lives in `evict.ts` and is pure; everything here
// touches the filesystem.

import { datasetMarkerPath } from "@/lib/paths"
import {
  datasetSize,
  listDatasets,
  readJson,
  removeDataset,
  writeJson,
} from "@/lib/opfs"
import type { DatasetRecord } from "@/lib/evict"
import type { ChannelStats } from "@/lib/stats"
import type { H5JInfo, ResolvedDims } from "@/types"

/** Bumped if the shape below changes; an unreadable marker means "incomplete". */
const MARKER_VERSION = 2

export interface DatasetMarker {
  version: number
  id: string
  /** The file's name, as shown in the bar. */
  name: string
  /** Where it came from, or null for a dropped local file. */
  sourceUrl: string | null
  createdAt: number
  lastUsedAt: number
  bytes: number
  /**
   * Everything needed to show this volume again without opening the H5J.
   *
   * This is what makes reuse worth having rather than merely possible. With only the
   * chunks on disk, a second load would still have to download the file and decode a
   * channel to learn its geometry and how to scale it -- which is nearly all of the
   * cost. With these three, the viewer mounts from the address bar alone.
   *
   * `dims` could almost be recovered by reading the `.zarray` shape back, but `stats`
   * could not: contrast comes from measuring the voxels, and falling back to the dtype
   * range renders these volumes near-black. Channel_0 of a typical stack peaks at 174
   * out of 4095.
   */
  info: H5JInfo
  dims: ResolvedDims
  /** Per channel, in container order. A hole is a channel that was never measured. */
  stats: Array<ChannelStats | undefined>
}

/**
 * Record the completed conversion. Written last, after every chunk, because its
 * presence is what distinguishes a dataset that can be viewed from a tree that a
 * failed run left behind.
 */
export async function markComplete(opts: {
  datasetId: string
  name: string
  sourceUrl: string | null
  now: number
  info: H5JInfo
  dims: ResolvedDims
  stats: Array<ChannelStats | undefined>
}): Promise<void> {
  const marker: DatasetMarker = {
    version: MARKER_VERSION,
    id: opts.datasetId,
    name: opts.name,
    sourceUrl: opts.sourceUrl,
    createdAt: opts.now,
    lastUsedAt: opts.now,
    info: opts.info,
    dims: opts.dims,
    stats: opts.stats,
    // Measured rather than projected. The projection is deliberately generous, and
    // evicting on generous numbers would discard more than it needed to.
    bytes: await datasetSize(opts.datasetId),
  }
  await writeJson(datasetMarkerPath(opts.datasetId), marker)
}

/**
 * Note that a dataset was opened, so it moves to the back of the eviction queue.
 *
 * Never throws: this is bookkeeping, and failing to record a use is not a reason to
 * refuse to show someone their data. The cost of a lost touch is that the dataset looks
 * staler than it is and may be evicted sooner.
 */
export async function touchDataset(
  datasetId: string,
  now: number
): Promise<void> {
  try {
    const marker = await readJson<DatasetMarker>(datasetMarkerPath(datasetId))
    if (!marker) return
    await writeJson(datasetMarkerPath(datasetId), {
      ...marker,
      lastUsedAt: now,
    })
  } catch {
    // Ignored on purpose -- see above.
  }
}

/**
 * Every dataset in storage, as eviction sees it.
 *
 * A dataset with no readable marker is reported as incomplete with a `lastUsedAt` of 0,
 * which sorts it to the front of the queue. That is the right reading in both cases it
 * arises: debris from a run that died before finishing, and a tree written by a build
 * from before markers existed, which the current code cannot serve anyway.
 */
export async function listDatasetRecords(): Promise<DatasetRecord[]> {
  const ids = await listDatasets()
  return Promise.all(ids.map(toRecord))
}

/**
 * A complete, usable marker for this id, or null.
 *
 * Null covers every reason not to reuse: nothing there, a half-written run, a marker
 * from a build whose shape differed, or one missing the geometry a mount needs. The
 * caller's response to all of them is the same -- convert it.
 */
export async function readUsableMarker(
  datasetId: string
): Promise<DatasetMarker | null> {
  let marker: DatasetMarker | null = null
  try {
    marker = await readJson<DatasetMarker>(datasetMarkerPath(datasetId))
  } catch {
    return null
  }
  if (!marker || marker.version !== MARKER_VERSION) return null
  if (!marker.info?.channels?.length || !marker.dims?.size) return null
  return marker
}

async function toRecord(id: string): Promise<DatasetRecord> {
  let marker: DatasetMarker | null = null
  try {
    marker = await readJson<DatasetMarker>(datasetMarkerPath(id))
  } catch {
    marker = null
  }

  if (!marker || marker.version !== MARKER_VERSION) {
    return { id, bytes: await sizeOf(id), lastUsedAt: 0, complete: false }
  }
  return {
    id,
    // A marker written before a later build changed the layout can carry a stale size.
    // Falling back to a walk when it is missing or nonsensical keeps eviction honest
    // about how much a removal will actually free.
    bytes:
      Number.isFinite(marker.bytes) && marker.bytes > 0
        ? marker.bytes
        : await sizeOf(id),
    lastUsedAt: Number.isFinite(marker.lastUsedAt) ? marker.lastUsedAt : 0,
    complete: true,
  }
}

async function sizeOf(id: string): Promise<number> {
  try {
    return await datasetSize(id)
  } catch {
    return 0
  }
}

/**
 * Remove datasets, reporting how many went. Never throws on an individual failure.
 *
 * `onRemoved` fires after each one so a caller can show progress. Granularity is one
 * dataset: `removeEntry(recursive)` is a single opaque call, so a four-gigabyte volume
 * is one step however long it takes. Walking and deleting file by file would move the
 * bar more smoothly and finish later, which is the wrong trade.
 */
export async function evictDatasets(
  ids: string[],
  onRemoved?: (done: number, total: number) => void
): Promise<number> {
  let removed = 0
  for (const id of ids) {
    try {
      await removeDataset(id)
      removed += 1
    } catch {
      // One that will not delete should not stop the others; the caller re-measures
      // free space afterwards rather than trusting a count.
    }
    onRemoved?.(removed, ids.length)
  }
  return removed
}

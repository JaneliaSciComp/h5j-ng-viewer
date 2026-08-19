// Chunk and downsample one decoded channel into OPFS.
//
// Runs in a dedicated worker for two reasons: it keeps the multi-second chunking loop
// off the UI thread, and `createSyncAccessHandle()` (the fast OPFS write path) is
// worker-only. Decoding is NOT done here -- ffmpeg.wasm 0.10 injects a `<script>` tag
// and so needs a document; the main thread decodes and transfers the buffer in.

import {
  buildZarray,
  buildZattrs,
  buildZgroup,
  CHUNK,
  chunkBytes,
  downsample2x,
  gatherChunk,
  pyramid,
} from "@/lib/zarr"
import { openPackedWriter, writeJson } from "@/lib/opfs"
import {
  chunkFilePath,
  levelIndexPath,
  zarrayPath,
  zattrsPath,
  zgroupPath,
} from "@/lib/paths"
import type {
  IngestMessage,
  IngestRequest,
  LevelIndex,
  LevelInfo,
  Vec3,
} from "@/types"

type VoxelArray = Uint8Array | Uint16Array

/** A volume plus the strides needed to read it. Level 0 is padded; later levels are not. */
interface Source {
  data: VoxelArray
  size: Vec3
  strideX: number
  strideY: number
}

const post = (message: IngestMessage) => self.postMessage(message)

self.onmessage = async (event: MessageEvent<IngestRequest>) => {
  try {
    await ingest(event.data)
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function ingest(request: IngestRequest): Promise<void> {
  // A partially ingested dataset is still readable: zarr treats a missing chunk as
  // fill_value, so channels that have not been written yet render as zeros instead of
  // failing the load. That is why each channel gets its own packed file.
  const { datasetId, bits, dims, channelIndex } = request
  const levels = pyramid(dims.size)

  // Metadata is rewritten on every channel rather than only on the first. It is four
  // small JSON documents, and writing it unconditionally means a re-ingest or an
  // out-of-order channel cannot leave a dataset described by stale metadata.
  await writeMetadata(request, levels)

  const totalChunks = levels.reduce(
    (sum, level) => sum + level.grid[0] * level.grid[1] * level.grid[2],
    0
  )
  let writtenChunks = 0

  let source: Source = {
    data: view(request.data, bits),
    size: dims.size,
    strideX: dims.padX,
    strideY: dims.padY,
  }
  // Release the request's own handle on the level-0 buffer. Otherwise it stays
  // reachable through `request` for the whole pyramid loop, and at 16-bit the real
  // 1210x566x174 volume is ~230 MB per channel -- enough that holding it alongside
  // its child doubles peak memory. `source` is reassigned each level, so once this
  // reference is gone the parent level becomes collectable on schedule.
  request.data = new ArrayBuffer(0)

  const scratch = allocate(CHUNK[0] * CHUNK[1] * CHUNK[2], bits)

  for (const level of levels) {
    if (level.level > 0) {
      post({
        type: "phase",
        phase: "downsampling",
        level: level.level,
        levelCount: levels.length,
      })
      const reduced = downsample2x(
        source.data,
        source.size,
        source.strideX,
        source.strideY
      )
      // Drop the previous level before allocating further, so peak memory is one
      // level plus its half-scale child rather than the whole pyramid.
      source = {
        data: reduced.data,
        size: reduced.size,
        strideX: reduced.size.x,
        strideY: reduced.size.y,
      }
    }

    post({
      type: "phase",
      phase: "writing",
      level: level.level,
      levelCount: levels.length,
    })

    const writer = await openPackedWriter(
      chunkFilePath(datasetId, level.level, channelIndex)
    )
    try {
      const [gz, gy, gx] = level.grid
      // z outer, then y, then x. This ordering IS the index: the service worker
      // recovers a chunk's offset as ((z * gy + y) * gx + x) * chunkBytes, and that
      // is the only place the arithmetic exists. Do not reorder these loops.
      for (let z = 0; z < gz; z += 1) {
        for (let y = 0; y < gy; y += 1) {
          for (let x = 0; x < gx; x += 1) {
            gatherChunk(
              source.data,
              source.size,
              source.strideX,
              source.strideY,
              z,
              y,
              x,
              scratch
            )
            writer.write(scratch)
            writtenChunks += 1
          }
        }
        post({ type: "progress", fraction: writtenChunks / totalChunks })
      }
    } finally {
      await writer.close()
    }

    post({ type: "levelReady", level: level.level })
  }

  post({ type: "done", levels })
}

async function writeMetadata(
  request: IngestRequest,
  levels: LevelInfo[]
): Promise<void> {
  const {
    datasetId,
    datasetName,
    bits,
    dims,
    channelCount,
    channelNames,
    channelColors,
  } = request

  await writeJson(zgroupPath(datasetId), buildZgroup())
  await writeJson(
    zattrsPath(datasetId),
    buildZattrs({
      datasetName,
      levels,
      voxelSize: dims.voxelSize,
      channelNames,
      channelColors,
      bits,
    })
  )

  for (const level of levels) {
    await writeJson(
      zarrayPath(datasetId, level.level),
      buildZarray(level.size, channelCount, bits)
    )
    const index: LevelIndex = {
      grid: level.grid,
      chunkBytes: chunkBytes(bits),
    }
    await writeJson(levelIndexPath(datasetId, level.level), index)
  }
}

function view(buffer: ArrayBuffer, bits: 8 | 16): VoxelArray {
  return bits === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer)
}

function allocate(length: number, bits: 8 | 16): VoxelArray {
  return bits === 16 ? new Uint16Array(length) : new Uint8Array(length)
}

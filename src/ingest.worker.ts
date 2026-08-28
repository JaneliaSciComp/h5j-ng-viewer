// Chunk and downsample one decoded channel into its own OME-Zarr array in OPFS.
//
// One array per channel, so this run owns every byte it writes: chunks are appended in
// order and a chunk is complete the moment it is written. When all channels shared an
// array a chunk could not be finished until the last channel had contributed to it,
// which is what made a partly-converted dataset unsafe to display.
//
// Runs in a dedicated worker for two reasons: it keeps the multi-second chunking loop
// off the UI thread, and `createSyncAccessHandle()` (the fast OPFS write path) is
// worker-only. Decoding is NOT done here -- ffmpeg.wasm 0.10 injects a `<script>` tag
// and so needs a document; the main thread decodes and transfers the buffer in.

import {
  chunkVoxels,
  downsample2x,
  gatherChunk,
  pyramid,
} from "@/lib/zarr"
import { openPackedWriter } from "@/lib/opfs"
import { measureChannel } from "@/lib/stats"
import { chunksFilePath } from "@/lib/paths"
import type { IngestMessage, IngestRequest, Vec3 } from "@/types"

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
  const { datasetId, bits, dims, channelIndex } = request
  const levels = pyramid(dims.size)

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

  // Measured before chunking, while the level-0 data is still to hand. Contrast is
  // seeded from this rather than from the dtype range: fluorescence volumes are mostly
  // near-zero background, so a [0, 4095] window maps the real signal to near-black and
  // the viewer looks empty. It is also the one number that distinguishes "the data is
  // zeros" from "the data is fine but invisible".
  post({
    type: "stats",
    channelIndex,
    stats: measureChannel(
      source.data,
      source.size,
      source.strideX,
      source.strideY,
      bits
    ),
  })

  const scratch = allocate(chunkVoxels(), bits)

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
      chunksFilePath(datasetId, channelIndex, level.level)
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
            // Straight append: this array is this channel's alone, so the write
            // cursor is already where the chunk belongs.
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

function view(buffer: ArrayBuffer, bits: 8 | 16): VoxelArray {
  return bits === 16 ? new Uint16Array(buffer) : new Uint8Array(buffer)
}

function allocate(length: number, bits: 8 | 16): VoxelArray {
  return bits === 16 ? new Uint16Array(length) : new Uint8Array(length)
}

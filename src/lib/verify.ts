// Probes a converted dataset the same way Neuroglancer would: through the service
// worker, over HTTP, level by level.
//
// This exists because the failure mode it catches is silent. Zarr reads a missing
// chunk as `fill_value`, so a level whose chunks 404 renders as empty black with no
// error anywhere -- and requests issued from Neuroglancer's chunk worker are not
// always visible in the browser's network panel, which makes it hard to tell "no
// chunks were requested" from "every chunk request failed".

const BYTES_PER_ELEMENT: Record<string, number> = {
  "|u1": 1,
  "<u2": 2,
  ">u2": 2,
}

export interface LevelProbe {
  /** Which channel's array this level belongs to. */
  channel: number
  /** Dataset path from the multiscales metadata, e.g. "0". */
  path: string
  zarrayStatus: number
  shape: number[] | null
  /** The chunk key that was requested, e.g. "1.4.9". */
  chunkKey: string | null
  chunkStatus: number | null
  /** Bytes actually returned. */
  chunkLength: number | null
  /** Bytes the .zarray implies a chunk should be. */
  expectedLength: number | null
  /** Largest voxel value in the fetched chunk, or null when it could not be read. */
  maxValue: number | null
}

export interface DatasetProbe {
  /** Status of each channel's .zattrs, in channel order. */
  zattrsStatuses: number[]
  levels: LevelProbe[]
  /** Human-readable problems, empty when everything checks out. */
  problems: string[]
}

/**
 * Probes every channel's pyramid: each level's metadata, and one chunk near the volume
 * center. Each channel is its own zarr array, so each is probed separately -- a channel
 * whose array never got written is exactly the failure this is here to name, and it is
 * invisible in a probe that only looks at one of them.
 */
export async function probeDataset(
  origin: string,
  datasetId: string,
  channelCount: number
): Promise<DatasetProbe> {
  const zattrsStatuses: number[] = []
  const levels: LevelProbe[] = []
  const problems: string[] = []

  for (let channel = 0; channel < channelCount; channel += 1) {
    const base = `${origin}/zarr/${datasetId}/c${channel}`

    const zattrsResponse = await fetch(`${base}/.zattrs`)
    zattrsStatuses.push(zattrsResponse.status)
    if (!zattrsResponse.ok) {
      problems.push(
        `channel ${channel}: .zattrs returned ${zattrsResponse.status}`
      )
      continue
    }

    const zattrs = (await zattrsResponse.json()) as {
      multiscales?: Array<{ datasets?: Array<{ path?: string }> }>
    }
    const paths =
      zattrs.multiscales?.[0]?.datasets
        ?.map((dataset) => dataset.path)
        .filter((path): path is string => typeof path === "string") ?? []

    if (paths.length === 0) {
      problems.push(`channel ${channel}: multiscales lists no datasets`)
    }

    for (const path of paths) {
      const probe = await probeLevel(base, channel, path)
      levels.push(probe)
      const where = `channel ${channel} level ${path}`

      if (probe.zarrayStatus !== 200) {
        problems.push(`${where}: .zarray returned ${probe.zarrayStatus}`)
        continue
      }
      if (probe.chunkStatus !== 200) {
        problems.push(
          `${where}: chunk ${probe.chunkKey} returned ${probe.chunkStatus}`
        )
        continue
      }
      if (probe.chunkLength !== probe.expectedLength) {
        problems.push(
          `${where}: chunk ${probe.chunkKey} is ${probe.chunkLength} bytes, ` +
            `expected ${probe.expectedLength}`
        )
      }
    }
  }

  // Every level being readable but empty is a different bug from a serving failure,
  // so it gets its own message rather than being lumped in above.
  const readable = levels.filter((level) => level.maxValue !== null)
  if (readable.length > 0 && readable.every((level) => level.maxValue === 0)) {
    problems.push(
      "every probed chunk is entirely zeros, so nothing will be visible"
    )
  }

  return { zattrsStatuses, levels, problems }
}

async function probeLevel(
  base: string,
  channel: number,
  path: string
): Promise<LevelProbe> {
  const empty: LevelProbe = {
    channel,
    path,
    zarrayStatus: 0,
    shape: null,
    chunkKey: null,
    chunkStatus: null,
    chunkLength: null,
    expectedLength: null,
    maxValue: null,
  }

  const zarrayResponse = await fetch(`${base}/${path}/.zarray`)
  if (!zarrayResponse.ok) {
    return { ...empty, zarrayStatus: zarrayResponse.status }
  }

  const zarray = (await zarrayResponse.json()) as {
    shape: number[]
    chunks: number[]
    dtype: string
  }
  const chunkKey = centerChunkKey(zarray.shape, zarray.chunks)
  const elementBytes = BYTES_PER_ELEMENT[zarray.dtype] ?? 1
  const expectedLength =
    zarray.chunks.reduce((product, size) => product * size, 1) * elementBytes

  const chunkResponse = await fetch(`${base}/${path}/${chunkKey}`)
  if (!chunkResponse.ok) {
    return {
      ...empty,
      zarrayStatus: 200,
      shape: zarray.shape,
      chunkKey,
      chunkStatus: chunkResponse.status,
      expectedLength,
    }
  }

  const buffer = await chunkResponse.arrayBuffer()
  const voxels =
    elementBytes === 2 ? new Uint16Array(buffer) : new Uint8Array(buffer)
  let maxValue = 0
  for (let index = 0; index < voxels.length; index += 1) {
    if (voxels[index] > maxValue) maxValue = voxels[index]
  }

  return {
    channel,
    path,
    zarrayStatus: 200,
    shape: zarray.shape,
    chunkKey,
    chunkStatus: 200,
    chunkLength: buffer.byteLength,
    expectedLength,
    maxValue,
  }
}

/**
 * Chunk key for the chunk nearest the volume center. The corner chunk (0.0.0) is
 * background in almost any real scan, so probing it cannot distinguish empty data from
 * an empty corner.
 *
 * Three axes: each channel is its own [z, y, x] array.
 */
export function centerChunkKey(shape: number[], chunks: number[]): string {
  const center = shape.map((extent, axis) =>
    Math.floor(Math.ceil(extent / chunks[axis]) / 2)
  )
  return center.join(".")
}

/** One line per level, for display. */
export function describeProbe(probe: DatasetProbe): string[] {
  return probe.levels.map((level) => {
    const where = `c${level.channel} level ${level.path}`
    if (level.zarrayStatus !== 200) {
      return `${where}: .zarray ${level.zarrayStatus}`
    }
    const shape = level.shape ? level.shape.join("×") : "?"
    if (level.chunkStatus !== 200) {
      return `${where} [${shape}]: chunk ${level.chunkKey} → ${level.chunkStatus}`
    }
    return (
      `${where} [${shape}]: chunk ${level.chunkKey} ok, ` +
      `${level.chunkLength}/${level.expectedLength} bytes, max ${level.maxValue}`
    )
  })
}

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
  /** Dataset path from the multiscales metadata, e.g. "0". */
  path: string
  zarrayStatus: number
  shape: number[] | null
  /** The chunk key that was requested, e.g. "0.1.4.9". */
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
  zattrsStatus: number
  levels: LevelProbe[]
  /** Human-readable problems, empty when everything checks out. */
  problems: string[]
}

/** Probes every pyramid level's metadata and one chunk near the volume centre. */
export async function probeDataset(
  origin: string,
  datasetId: string
): Promise<DatasetProbe> {
  const base = `${origin}/zarr/${datasetId}`
  const problems: string[] = []

  const zattrsResponse = await fetch(`${base}/.zattrs`)
  if (!zattrsResponse.ok) {
    return {
      zattrsStatus: zattrsResponse.status,
      levels: [],
      problems: [`.zattrs returned ${zattrsResponse.status}`],
    }
  }

  const zattrs = (await zattrsResponse.json()) as {
    multiscales?: Array<{ datasets?: Array<{ path?: string }> }>
  }
  const paths =
    zattrs.multiscales?.[0]?.datasets
      ?.map((dataset) => dataset.path)
      .filter((path): path is string => typeof path === "string") ?? []

  if (paths.length === 0) problems.push("multiscales lists no datasets")

  const levels: LevelProbe[] = []
  for (const path of paths) {
    const probe = await probeLevel(base, path)
    levels.push(probe)

    if (probe.zarrayStatus !== 200) {
      problems.push(`level ${path}: .zarray returned ${probe.zarrayStatus}`)
      continue
    }
    if (probe.chunkStatus !== 200) {
      problems.push(
        `level ${path}: chunk ${probe.chunkKey} returned ${probe.chunkStatus}`
      )
      continue
    }
    if (probe.chunkLength !== probe.expectedLength) {
      problems.push(
        `level ${path}: chunk ${probe.chunkKey} is ${probe.chunkLength} bytes, ` +
          `expected ${probe.expectedLength}`
      )
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

  return { zattrsStatus: zattrsResponse.status, levels, problems }
}

async function probeLevel(base: string, path: string): Promise<LevelProbe> {
  const empty: LevelProbe = {
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
  const chunkKey = centreChunkKey(zarray.shape, zarray.chunks)
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
 * Chunk key for the chunk nearest the volume centre, on channel 0. The corner chunk
 * (0.0.0.0) is background in almost any real scan, so probing it cannot distinguish
 * empty data from an empty corner.
 */
export function centreChunkKey(shape: number[], chunks: number[]): string {
  const grid = [1, 2, 3].map((axis) => Math.ceil(shape[axis] / chunks[axis]))
  const centre = grid.map((extent) => Math.floor(extent / 2))
  return `0.${centre[0]}.${centre[1]}.${centre[2]}`
}

/** One line per level, for display. */
export function describeProbe(probe: DatasetProbe): string[] {
  return probe.levels.map((level) => {
    if (level.zarrayStatus !== 200) {
      return `level ${level.path}: .zarray ${level.zarrayStatus}`
    }
    const shape = level.shape ? level.shape.join("×") : "?"
    if (level.chunkStatus !== 200) {
      return `level ${level.path} [${shape}]: chunk ${level.chunkKey} → ${level.chunkStatus}`
    }
    return (
      `level ${level.path} [${shape}]: chunk ${level.chunkKey} ok, ` +
      `${level.chunkLength}/${level.expectedLength} bytes, max ${level.maxValue}`
    )
  })
}

// Drives the real, unmodified public/sw.js under Node against an in-memory OPFS
// populated by the real ingest primitives (pyramid/gatherChunk/buildZ*). This is the
// only place that exercises the shipped file itself: the header and range contract it
// has to honor for Neuroglancer's chunk fetches.

import { beforeAll, describe, expect, it } from "vitest"
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
import {
  chunksFilePath,
  levelIndexPath,
  levelPath,
  zarrayPath,
  zattrsPath,
  zgroupPath,
} from "@/lib/paths"
import type { LevelIndex, LevelInfo, Vec3 } from "@/types"

// ---- minimal in-memory OPFS, just enough for sw.js's read-only usage ----

class MemoryFile {
  private bytes = new Uint8Array(0)

  write(data: Uint8Array<ArrayBufferLike>): void {
    // Copy rather than alias: this also normalizes onto a plain ArrayBuffer, since a
    // Blob (used by getFile() below) can't be built from a SharedArrayBuffer-backed view.
    this.bytes = new Uint8Array(data)
  }

  async getFile(): Promise<Blob> {
    return new Blob([this.bytes])
  }
}

class MemoryDirectory {
  private entries = new Map<string, MemoryDirectory | MemoryFile>()

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<MemoryDirectory> {
    let entry = this.entries.get(name)
    if (!entry) {
      if (!options?.create) throw new DOMException(name, "NotFoundError")
      entry = new MemoryDirectory()
      this.entries.set(name, entry)
    }
    if (!(entry instanceof MemoryDirectory))
      throw new DOMException(name, "TypeMismatchError")
    return entry
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<MemoryFile> {
    let entry = this.entries.get(name)
    if (!entry) {
      if (!options?.create) throw new DOMException(name, "NotFoundError")
      entry = new MemoryFile()
      this.entries.set(name, entry)
    }
    if (!(entry instanceof MemoryFile))
      throw new DOMException(name, "TypeMismatchError")
    return entry
  }
}

/** Write `bytes` at a slash-separated, leading-slash-free path, creating dirs as needed. */
async function putFile(
  root: MemoryDirectory,
  path: string,
  bytes: Uint8Array
): Promise<void> {
  const parts = path.split("/")
  const name = parts.pop()
  if (!name) throw new Error(`invalid path: ${path}`)
  let dir = root
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  const handle = await dir.getFileHandle(name, { create: true })
  handle.write(bytes)
}

function putJson(
  root: MemoryDirectory,
  path: string,
  value: unknown
): Promise<void> {
  return putFile(root, path, new TextEncoder().encode(JSON.stringify(value)))
}

// ---- fake service worker globals, installed before sw.js is imported ----

const ORIGIN = "https://sw-test.example"

type AnyListener = (event: unknown) => void

const listeners = new Map<string, AnyListener>()

const fakeSelf = {
  addEventListener(type: string, cb: AnyListener) {
    listeners.set(type, cb)
  },
  skipWaiting() {},
  clients: { claim: () => Promise.resolve() },
  location: { origin: ORIGIN },
}

interface FakeFetchEvent {
  request: Request
  respondWith(response: Promise<Response> | Response): void
}

/** Calls the registered fetch listener and returns whatever it passed to respondWith,
 * or undefined if it never called respondWith (the "ignore this request" path). */
function dispatchFetch(request: Request): Promise<Response> | undefined {
  const fetchListener = listeners.get("fetch")
  if (!fetchListener) throw new Error("sw.js did not register a fetch listener")
  let captured: Promise<Response> | undefined
  const event: FakeFetchEvent = {
    request,
    respondWith(response) {
      captured = Promise.resolve(response)
    },
  }
  fetchListener(event)
  return captured
}

function requestFor(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}/${path}`, init)
}

// ---- fixture: a real (small, non-cubical) ingested volume, two channels ----

const DATASET_ID = "ds1"
const SIZE: Vec3 = { x: 150, y: 140, z: 135 } // grid [3,3,3] at level 0: an interior
// chunk exists, plus a partial edge chunk on every axis, and MAX_LEVEL_DIM=128 forces
// exactly one more (fully different-shaped) pyramid level.
const PAD_X = 154
const PAD_Y = 144
const BITS = 16 as const
const CHANNEL_COUNT = 2
const CHANNEL_NAMES = ["ch0", "ch1"]
const CHANNEL_COLORS = ["#ff0000", "#00ff00"]

const levels: LevelInfo[] = pyramid(SIZE)
const CHUNK_VOXELS = CHUNK[0] * CHUNK[1] * CHUNK[2]
// One channel per array, so a chunk is one channel's and its size does not depend on
// how many channels the container has.
const CHUNK_BYTES = chunkBytes(BITS)

/** Deterministic, channel-distinguishing, never-zero (so it can't be mistaken for
 * zero-padding fill_value). */
function voxelValue(channel: number, x: number, y: number, z: number): number {
  return ((channel * 20000 + x * 7 + y * 13 + z * 31) % 40000) + 1
}

// sourcesByLevel[levelIndex][channel] is that level's voxel data; strides describe how
// to index it. Level 0 is padded (mirrors a real H.265 decode); later levels are the
// tightly-packed output of downsample2x, exactly as src/ingest.worker.ts produces.
const sourcesByLevel: Uint16Array[][] = []
const stridesByLevel: { x: number; y: number }[] = []

for (let levelIdx = 0; levelIdx < levels.length; levelIdx += 1) {
  const level = levels[levelIdx]
  if (levelIdx === 0) {
    const stride = { x: PAD_X, y: PAD_Y }
    const perChannel: Uint16Array[] = []
    for (let c = 0; c < CHANNEL_COUNT; c += 1) {
      const data = new Uint16Array(PAD_X * PAD_Y * SIZE.z)
      data.fill(0xffff) // sentinel: must never survive a crop into a served chunk
      for (let z = 0; z < SIZE.z; z += 1) {
        for (let y = 0; y < SIZE.y; y += 1) {
          for (let x = 0; x < SIZE.x; x += 1) {
            data[(z * PAD_Y + y) * PAD_X + x] = voxelValue(c, x, y, z)
          }
        }
      }
      perChannel.push(data)
    }
    sourcesByLevel.push(perChannel)
    stridesByLevel.push(stride)
  } else {
    const prevSize = levels[levelIdx - 1].size
    const prevStride = stridesByLevel[levelIdx - 1]
    const perChannel: Uint16Array[] = []
    for (let c = 0; c < CHANNEL_COUNT; c += 1) {
      const reduced = downsample2x(
        sourcesByLevel[levelIdx - 1][c],
        prevSize,
        prevStride.x,
        prevStride.y
      )
      perChannel.push(reduced.data)
    }
    sourcesByLevel.push(perChannel)
    stridesByLevel.push({ x: level.size.x, y: level.size.y })
  }
}

/** The bytes gatherChunk produces for one channel's sub-block of a chunk. */
function expectedChannelBytes(
  levelIdx: number,
  channel: number,
  cz: number,
  cy: number,
  cx: number
): Uint8Array {
  const level = levels[levelIdx]
  const stride = stridesByLevel[levelIdx]
  const scratch = new Uint16Array(CHUNK_VOXELS)
  gatherChunk(
    sourcesByLevel[levelIdx][channel],
    level.size,
    stride.x,
    stride.y,
    cz,
    cy,
    cx,
    scratch
  )
  return new Uint8Array(scratch.buffer)
}

/** Path for a chunk key. Three indices now: the array is three-dimensional. */
function chunkKeyPath(
  levelIdx: number,
  channel: number,
  cz: number,
  cy: number,
  cx: number
): string {
  const level = levelPath(DATASET_ID, channel, levels[levelIdx].level)
  return `${level}/${cz}.${cy}.${cx}`
}

async function writeFixture(root: MemoryDirectory): Promise<void> {
  for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
    await putJson(root, zgroupPath(DATASET_ID, channel), buildZgroup())
    await putJson(
      root,
      zattrsPath(DATASET_ID, channel),
      buildZattrs({
        name: CHANNEL_NAMES[channel],
        levels,
        voxelSize: { x: 0.5, y: 0.5, z: 1.5 },
        color: CHANNEL_COLORS[channel],
        bits: BITS,
      })
    )

    for (let levelIdx = 0; levelIdx < levels.length; levelIdx += 1) {
      const level = levels[levelIdx]
      await putJson(
        root,
        zarrayPath(DATASET_ID, channel, level.level),
        buildZarray(level.size, BITS)
      )
      const index: LevelIndex = { grid: level.grid, chunkBytes: CHUNK_BYTES }
      await putJson(
        root,
        levelIndexPath(DATASET_ID, channel, level.level),
        index
      )

      const [gz, gy, gx] = level.grid
      const stride = stridesByLevel[levelIdx]
      // Chunks appended in z, then y, then x -- must match src/ingest.worker.ts
      // exactly, because that ordering IS the index the service worker inverts.
      const packed = new Uint16Array(gz * gy * gx * CHUNK_VOXELS)
      const scratch = new Uint16Array(CHUNK_VOXELS)
      let cursor = 0
      for (let z = 0; z < gz; z += 1) {
        for (let y = 0; y < gy; y += 1) {
          for (let x = 0; x < gx; x += 1) {
            gatherChunk(
              sourcesByLevel[levelIdx][channel],
              level.size,
              stride.x,
              stride.y,
              z,
              y,
              x,
              scratch
            )
            packed.set(scratch, cursor)
            cursor += CHUNK_VOXELS
          }
        }
      }
      await putFile(
        root,
        chunksFilePath(DATASET_ID, channel, level.level),
        new Uint8Array(packed.buffer)
      )
    }
  }
}

let root: MemoryDirectory

beforeAll(async () => {
  root = new MemoryDirectory()
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  })
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    value: fakeSelf,
  })

  // sw.js registers its listeners as a side effect of being imported. Do this once
  // for the whole file: a second dynamic import of the same path is a no-op cache hit.
  // It is outside "src" (tsconfig's only "include") and plain, dependency-free JS with
  // no declaration file, so the specifier is routed through a non-literal expression --
  // TypeScript only attempts module resolution (and would fail without ambient types)
  // when the argument to a dynamic import is a string literal.
  const swPath = "../../public/sw.js"
  await import(swPath)

  await writeFixture(root)
})

/** Fast byte-exact comparison. `toEqual`'s element-by-element deep-equality is
 * unusably slow (~1s) on a 512KB typed array; Buffer.equals does the same check in
 * native code in under a millisecond. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return (
    a.length === b.length &&
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
      Buffer.from(b.buffer, b.byteOffset, b.byteLength)
    )
  )
}

function expectBaseHeaders(headers: Headers): void {
  expect(headers.get("accept-ranges")).toBe("bytes")
  expect(headers.get("cross-origin-resource-policy")).toBe("same-origin")
  expect(headers.get("cache-control")).toBe("no-store")
}

async function getResponse(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const captured = dispatchFetch(requestFor(path, init))
  if (!captured) throw new Error(`expected ${path} to be handled`)
  return captured
}

describe("metadata files", () => {
  it("serves .zgroup as JSON that round-trips", async () => {
    const res = await getResponse(zgroupPath(DATASET_ID, 0))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/json")
    expectBaseHeaders(res.headers)
    expect(await res.json()).toEqual(buildZgroup())
  })

  it.each([0, 1])(
    "serves channel %i's own .zattrs, describing that channel alone",
    async (channel) => {
      const res = await getResponse(zattrsPath(DATASET_ID, channel))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("application/json")
      expect(await res.json()).toEqual(
        buildZattrs({
          name: CHANNEL_NAMES[channel],
          levels,
          voxelSize: { x: 0.5, y: 0.5, z: 1.5 },
          color: CHANNEL_COLORS[channel],
          bits: BITS,
        })
      )
    }
  )

  it.each([0, 1])(
    "serves level %i .zarray and index.json",
    async (levelIdx) => {
      const level = levels[levelIdx]

      const zarrayRes = await getResponse(
        zarrayPath(DATASET_ID, 0, level.level)
      )
      expect(zarrayRes.status).toBe(200)
      expect(zarrayRes.headers.get("content-type")).toBe("application/json")
      expect(await zarrayRes.json()).toEqual(buildZarray(level.size, BITS))

      const indexRes = await getResponse(
        levelIndexPath(DATASET_ID, 0, level.level)
      )
      expect(indexRes.status).toBe(200)
      expect(indexRes.headers.get("content-type")).toBe("application/json")
      expect(await indexRes.json()).toEqual({
        grid: level.grid,
        chunkBytes: CHUNK_BYTES,
      })
    }
  )
})

describe("chunk bytes", () => {
  it.each([
    { label: "interior", levelIdx: 0, cz: 1, cy: 1, cx: 1 },
    { label: "edge on z", levelIdx: 0, cz: 2, cy: 1, cx: 1 },
    { label: "edge on y", levelIdx: 0, cz: 1, cy: 2, cx: 1 },
    { label: "edge on x", levelIdx: 0, cz: 1, cy: 1, cx: 2 },
    { label: "last of grid", levelIdx: 0, cz: 2, cy: 2, cx: 2 },
    { label: "level 1, first", levelIdx: 1, cz: 0, cy: 0, cx: 0 },
    { label: "level 1, last", levelIdx: 1, cz: 1, cy: 1, cx: 1 },
  ])(
    "returns exactly that channel's chunk for $label",
    async ({ levelIdx, cz, cy, cx }) => {
      for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
        const path = chunkKeyPath(levelIdx, channel, cz, cy, cx)
        const res = await getResponse(path)
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toBe("application/octet-stream")
        const body = new Uint8Array(await res.arrayBuffer())
        expect(
          bytesEqual(body, expectedChannelBytes(levelIdx, channel, cz, cy, cx))
        ).toBe(true)
      }
    }
  )

  it("serves different bytes for the same key under different channels", async () => {
    // Each channel is its own array, so the channel is part of the path rather than an
    // index inside the key. Getting that wrong would serve one channel's data for all
    // of them, which renders as plausible-looking but identical layers.
    const first = await (
      await getResponse(chunkKeyPath(0, 0, 1, 1, 1))
    ).arrayBuffer()
    const second = await (
      await getResponse(chunkKeyPath(0, 1, 1, 1, 1))
    ).arrayBuffer()
    expect(bytesEqual(new Uint8Array(first), new Uint8Array(second))).toBe(
      false
    )
  })

  it("reports Content-Length as the whole-chunk size, not the packed file size", async () => {
    const path = chunkKeyPath(0, 0, 1, 1, 1)
    const res = await getResponse(path)
    expect(res.headers.get("content-length")).toBe(String(CHUNK_BYTES))

    const [gz, gy, gx] = levels[0].grid
    const packedFileSize = gz * gy * gx * CHUNK_BYTES
    expect(packedFileSize).toBeGreaterThan(CHUNK_BYTES)
  })

  it("serves the same chunk correctly on a second request (index.json memo cache)", async () => {
    const path = chunkKeyPath(0, 0, 0, 0, 0)
    const expected = expectedChannelBytes(0, 0, 0, 0, 0)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await getResponse(path)
      expect(
        bytesEqual(new Uint8Array(await res.arrayBuffer()), expected)
      ).toBe(true)
    }
  })
})

describe("range requests", () => {
  const path = chunkKeyPath(0, 0, 1, 1, 1)
  const expected = expectedChannelBytes(0, 0, 1, 1, 1)

  it("bytes=0-0 is the size probe: 206, one byte, correct content-range", async () => {
    const res = await getResponse(path, { headers: { Range: "bytes=0-0" } })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(`bytes 0-0/${CHUNK_BYTES}`)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(1)
    expect(body[0]).toBe(expected[0])
  })

  it("serves a mid-range slice", async () => {
    const res = await getResponse(path, { headers: { Range: "bytes=100-199" } })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(
      `bytes 100-199/${CHUNK_BYTES}`
    )
    const body = new Uint8Array(await res.arrayBuffer())
    expect(bytesEqual(body, expected.slice(100, 200))).toBe(true)
  })

  it("serves an open-ended range to the end of the chunk", async () => {
    const res = await getResponse(path, { headers: { Range: "bytes=1000-" } })
    expect(res.status).toBe(206)
    expect(res.headers.get("content-range")).toBe(
      `bytes 1000-${CHUNK_BYTES - 1}/${CHUNK_BYTES}`
    )
    const body = new Uint8Array(await res.arrayBuffer())
    expect(bytesEqual(body, expected.slice(1000))).toBe(true)
  })

  it("responds 416 for an unsatisfiable range", async () => {
    const res = await getResponse(path, {
      headers: {
        Range: `bytes=${CHUNK_BYTES}-${CHUNK_BYTES + 10}`,
      },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe(`bytes */${CHUNK_BYTES}`)
  })
})

describe("HEAD requests", () => {
  it("matches GET headers on a chunk, with no body", async () => {
    const path = chunkKeyPath(0, 0, 0, 0, 0)
    const getRes = await getResponse(path)
    const headRes = await getResponse(path, { method: "HEAD" })
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get("content-length")).toBe(
      getRes.headers.get("content-length")
    )
    expect(headRes.headers.get("content-type")).toBe(
      getRes.headers.get("content-type")
    )
    expect((await headRes.arrayBuffer()).byteLength).toBe(0)
  })

  it("matches GET headers on a metadata file, with no body", async () => {
    const path = zattrsPath(DATASET_ID, 0)
    const getRes = await getResponse(path)
    const headRes = await getResponse(path, { method: "HEAD" })
    expect(headRes.status).toBe(200)
    expect(headRes.headers.get("content-length")).toBe(
      getRes.headers.get("content-length")
    )
    expect((await headRes.arrayBuffer()).byteLength).toBe(0)
  })
})

describe("method handling", () => {
  it("rejects PUT with 405", async () => {
    const res = await getResponse(zattrsPath(DATASET_ID, 0), { method: "PUT" })
    expect(res.status).toBe(405)
  })
})

describe("not found, and always resolves rather than rejects", () => {
  it.each([
    { label: "missing dataset", path: "zarr/does-not-exist/c0/.zattrs" },
    {
      label: "missing channel",
      path: `${levelPath(DATASET_ID, 9, 0)}/.zarray`,
    },
    { label: "missing level", path: `${levelPath(DATASET_ID, 0, 99)}/.zarray` },
    { label: "out-of-range z", path: chunkKeyPath(0, 0, 99, 1, 1) },
    { label: "out-of-range y", path: chunkKeyPath(0, 0, 1, 99, 1) },
    { label: "out-of-range x", path: chunkKeyPath(0, 0, 1, 1, 99) },
    {
      label: "malformed key: wrong part count",
      path: `${levelPath(DATASET_ID, 0, 0)}/1.2`,
    },
    {
      label: "malformed key: four indices, the old shape",
      path: `${levelPath(DATASET_ID, 0, 0)}/0.1.2.3`,
    },
    {
      label: "malformed key: non-numeric",
      path: `${levelPath(DATASET_ID, 0, 0)}/a.b.c`,
    },
    {
      label: "malformed key: negative index",
      path: `${levelPath(DATASET_ID, 0, 0)}/-1.0.0`,
    },
  ])("$label -> 404, resolves", async ({ path }) => {
    const captured = dispatchFetch(requestFor(path))
    expect(captured).toBeDefined()
    await expect(captured).resolves.toBeInstanceOf(Response)
    const res = await captured
    expect(res?.status).toBe(404)
  })
})

describe("routing guard", () => {
  it("ignores a non-/zarr/ path entirely", () => {
    const captured = dispatchFetch(requestFor("other/path"))
    expect(captured).toBeUndefined()
  })

  it("ignores a cross-origin request entirely", () => {
    const captured = dispatchFetch(
      new Request("https://other-origin.example/zarr/ds1/.zattrs")
    )
    expect(captured).toBeUndefined()
  })
})

describe("response headers", () => {
  it("carries the base header set on a successful chunk response", async () => {
    const res = await getResponse(chunkKeyPath(0, 0, 0, 0, 0))
    expectBaseHeaders(res.headers)
  })

  it("carries the base header set on a range response", async () => {
    const res = await getResponse(chunkKeyPath(0, 0, 0, 0, 0), {
      headers: { Range: "bytes=0-0" },
    })
    expectBaseHeaders(res.headers)
  })

  it("carries the base header set on a 404", async () => {
    const res = await getResponse("zarr/does-not-exist/.zattrs")
    expectBaseHeaders(res.headers)
  })
})

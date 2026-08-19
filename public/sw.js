// Service worker: virtual HTTP origin for the OME-Zarr hierarchy in OPFS.
//
// Neuroglancer can only read http(s)/gs/s3 kvstores (see notes/implementation-plan.md
// F3) -- there is no in-memory root store it can point at. This worker intercepts
// same-origin requests under /zarr/ and answers them out of OPFS so a stock
// Neuroglancer build believes it is talking to a real server.
//
// Plain, dependency-free JS -- this file is served verbatim from public/sw.js, so it
// cannot import anything. The OPFS layout mirrored below is defined authoritatively in
// src/lib/paths.ts; keep the two in sync by hand.
//
//   zarr/<datasetId>/.zgroup
//   zarr/<datasetId>/.zattrs
//   zarr/<datasetId>/<level>/.zarray
//   zarr/<datasetId>/<level>/index.json    -> { grid: [gz, gy, gx], chunkBytes }
//   zarr/<datasetId>/<level>/chunks.bin    -> every chunk, packed contiguously in
//                                              z-outer, y, x order. A chunk spans the
//                                              whole channel axis, so `c` in a chunk
//                                              key is always 0.
//
// The worker may be killed and restarted between any two requests (it has no
// lifetime guarantee), so it must not hold any ingest-derived state.

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith("/zarr/")) return
  event.respondWith(handleRequest(event.request, url))
})

// Parsed index.json values are pure functions of files already committed to OPFS --
// losing this cache (e.g. on worker restart) just costs a re-read, never correctness,
// so it's the one piece of state this worker is allowed to keep.
const indexCache = new Map()

async function handleRequest(request, url) {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: commonHeaders() })
    }
    const path = url.pathname.slice(1) // strip leading "/"; this IS the OPFS path
    const resolved = await resolvePath(path)
    if (!resolved) return notFound()
    return await respondWithBytes(
      request,
      resolved.getBytes,
      resolved.totalLength,
      resolved.contentType
    )
  } catch (err) {
    // Never let a rejection escape the fetch handler: Neuroglancer probes for
    // metadata files that legitimately don't exist, and an unhandled rejection here
    // stalls the whole load instead of just failing one speculative request.
    return new Response(String((err && err.message) || err), {
      status: 500,
      headers: commonHeaders(),
    })
  }
}

// Resolves a /zarr/... path to either a whole-file JSON resource or a slice of a
// packed chunk file. Returns null (not a throw) for "doesn't exist" / "malformed" so
// callers can 404 fast, which is the expected outcome for most Neuroglancer probes.
async function resolvePath(path) {
  const segments = path.split("/")
  const last = segments[segments.length - 1]

  if (
    last === ".zgroup" ||
    last === ".zattrs" ||
    last === ".zarray" ||
    last === "index.json"
  ) {
    return readWholeFile(segments)
  }

  const chunkKey = parseChunkKey(last)
  if (!chunkKey) return null

  const levelSegments = segments.slice(0, -1)
  const index = await getLevelIndex(levelSegments)
  if (!index) return null

  const { grid, chunkBytes } = index
  const [gz, gy, gx] = grid
  const { c, z, y, x } = chunkKey
  // chunks[0] === shape[0], so the channel axis is a single chunk and the only valid
  // index on it is 0. Every channel's data lives inside the chunk this resolves to.
  if (c !== 0) return null
  if (z < 0 || z >= gz || y < 0 || y >= gy || x < 0 || x >= gx) return null

  const file = await getFileAt(levelSegments.concat("chunks.bin"))
  if (!file) return null

  // The only place in the codebase this arithmetic exists (see src/lib/paths.ts):
  // the ingest worker just appends chunks in z -> y -> x order, so a chunk's byte
  // offset in the packed file is this single multiply-and-add.
  const offset = ((z * gy + y) * gx + x) * chunkBytes
  if (offset + chunkBytes > file.size) return null

  return {
    // Neuroglancer must see this chunk as an independent resource of length
    // chunkBytes -- NOT the size of the shared chunks.bin file it happens to live in.
    // Reporting the packed-file size here produces range mismatches that surface as
    // opaque fetch failures, not a clear error.
    totalLength: chunkBytes,
    contentType: "application/octet-stream",
    getBytes: (start, end) =>
      file.slice(offset + start, offset + end).arrayBuffer(),
  }
}

async function readWholeFile(segments) {
  const file = await getFileAt(segments)
  if (!file) return null
  return {
    totalLength: file.size,
    contentType: "application/json",
    getBytes: (start, end) => file.slice(start, end).arrayBuffer(),
  }
}

// Chunk keys are zarr v2 keys with dimension_separator "." and 4 indices because the
// array is [c, z, y, x], e.g. "1.2.3.4". Anything else (metadata files, garbage) is
// not a chunk key.
function parseChunkKey(name) {
  const parts = name.split(".")
  if (parts.length !== 4) return null
  const nums = parts.map(Number)
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  const [c, z, y, x] = nums
  return { c, z, y, x }
}

async function getLevelIndex(levelSegments) {
  const key = levelSegments.join("/")
  const cached = indexCache.get(key)
  if (cached) return cached

  const file = await getFileAt(levelSegments.concat("index.json"))
  if (!file) return null
  let parsed
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    return null
  }
  if (
    !parsed ||
    !Array.isArray(parsed.grid) ||
    typeof parsed.chunkBytes !== "number"
  )
    return null

  indexCache.set(key, parsed)
  return parsed
}

async function getFileAt(segments) {
  try {
    let dir = await navigator.storage.getDirectory()
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i])
    }
    const handle = await dir.getFileHandle(segments[segments.length - 1])
    return await handle.getFile()
  } catch {
    return null
  }
}

function notFound() {
  return new Response(null, { status: 404, headers: commonHeaders() })
}

// Headers every synthesized response carries, error responses included -- see
// notes/implementation-plan.md section 5.
function commonHeaders() {
  return {
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  }
}

function baseHeaders(contentType) {
  return {
    ...commonHeaders(),
    "Content-Type": contentType,
  }
}

// Parses a "bytes=<start>-<end>" Range header. `end` may be absent, meaning "to the
// end of the resource". Returns null if there is no Range header (caller should serve
// the whole resource) and throws-nothing on malformed headers -- treated as absent.
function parseRange(header, totalLength) {
  if (!header) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] === "" ? totalLength - 1 : Number(match[2])
  return { start, end }
}

async function respondWithBytes(request, getBytes, totalLength, contentType) {
  const range = parseRange(request.headers.get("range"), totalLength)

  if (!range) {
    const headers = {
      ...baseHeaders(contentType),
      "Content-Length": String(totalLength),
    }
    if (request.method === "HEAD")
      return new Response(null, { status: 200, headers })
    const body = await getBytes(0, totalLength)
    return new Response(body, { status: 200, headers })
  }

  const { start, end } = range
  if (start >= totalLength || start > end) {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders(contentType),
        "Content-Range": `bytes */${totalLength}`,
      },
    })
  }

  const clampedEnd = Math.min(end, totalLength - 1)
  const length = clampedEnd - start + 1
  const headers = {
    ...baseHeaders(contentType),
    "Content-Length": String(length),
    "Content-Range": `bytes ${start}-${clampedEnd}/${totalLength}`,
  }
  if (request.method === "HEAD")
    return new Response(null, { status: 206, headers })
  const body = await getBytes(start, clampedEnd + 1)
  return new Response(body, { status: 206, headers })
}

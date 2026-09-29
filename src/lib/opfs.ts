// Thin helpers over the Origin Private File System (OPFS). Two callers:
//
// - The ingest worker (src/ingest.worker.ts) writes hundreds of MB of packed chunk
//   data and needs createSyncAccessHandle() -- synchronous, worker-only, and much
//   faster than the async createWritable() path (see openPackedWriter below).
// - The main thread writes a handful of tiny JSON files and reads storage estimates.
//
// The service worker (public/sw.js) reads this data too, but it is dependency-free
// plain JS and re-derives paths itself; it does not import from here.

import { datasetPath, ZARR_ROOT } from "@/lib/paths"

// This project's tsconfig.json lib list includes "WebWorker" alongside "DOM", which
// is what pulls in FileSystemSyncAccessHandle / FileSystemFileHandle.createSyncAccessHandle
// (lib.webworker.d.ts) -- lib.dom.d.ts alone does not declare them. If that lib entry
// is ever dropped, redeclare a minimal FileSystemSyncAccessHandle-shaped interface
// here rather than reaching for `any` (@typescript-eslint/no-explicit-any is an ERROR
// in this repo).

// TypeScript also has no async-iteration types for FileSystemDirectoryHandle
// (`for await (const name of dir.keys())` is real per MDN but untyped). Declare the
// minimal shape we use.
/** FileSystemDirectoryHandle is an async-iterable of [name, handle] pairs at runtime. */
interface FileSystemDirectoryHandleIterable {
  keys(): AsyncIterableIterator<string>
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError"
}

function splitPath(path: string): { dir: string; name: string } {
  const parts = path.split("/").filter(Boolean)
  const name = parts.pop()
  if (!name) throw new Error(`invalid OPFS path: ${path}`)
  return { dir: parts.join("/"), name }
}

/** Resolve (creating if asked) the directory for a `a/b/c` path. */
export async function resolveDir(
  path: string,
  create: boolean
): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory()
  let dir = root
  for (const part of path.split("/").filter(Boolean)) {
    try {
      dir = await dir.getDirectoryHandle(part, { create })
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }
  return dir
}

/**
 * Rethrow an OPFS failure with the name of the fault and the file it happened to.
 *
 * Worth doing because of what the browser gives us on its own: "Failed to execute
 * 'createWritable' on 'FileSystemFileHandle'" is true of every write this app makes, so
 * on its own it says only that a write failed. The DOMException *name* is the part that
 * says what to do -- QuotaExceededError means the disk is full and the fix is to clear
 * data, NoModificationAllowedError means something else still holds the file open, and
 * NotAllowedError means permission. All three are indistinguishable from the message.
 */
function opfsFailure(
  err: unknown,
  action: string,
  path: string,
  bytesWritten?: number
): Error {
  // How far the write got, when we know it. Compared against the projected size this is
  // the most direct measure of the real limit -- and when the reported quota disagrees
  // with that limit, this is the number telling the truth.
  const got = bytesWritten === undefined ? "" : ` after ${bytesWritten} bytes`
  if (err instanceof DOMException) {
    return new Error(`${err.name}: ${action} ${path}${got} — ${err.message}`)
  }
  return err instanceof Error
    ? err
    : new Error(`${action} ${path}${got}: ${String(err)}`)
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const { dir, name } = splitPath(path)
  const dirHandle = await resolveDir(dir, true)
  if (!dirHandle) throw new Error(`cannot resolve directory for ${path}`)
  try {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(JSON.stringify(value))
    await writable.close()
  } catch (err) {
    throw opfsFailure(err, "writing", path)
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  const { dir, name } = splitPath(path)
  const dirHandle = await resolveDir(dir, false)
  if (!dirHandle) return null
  try {
    const fileHandle = await dirHandle.getFileHandle(name)
    const file = await fileHandle.getFile()
    return JSON.parse(await file.text()) as T
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** True when the path exists as a file. */
export async function fileExists(path: string): Promise<boolean> {
  const { dir, name } = splitPath(path)
  const dirHandle = await resolveDir(dir, false)
  if (!dirHandle) return false
  try {
    await dirHandle.getFileHandle(name)
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

/**
 * Writer for a level's packed chunk file. The service worker recovers each chunk's
 * offset by arithmetic, so this writer must never reorder or pad between chunks.
 *
 * `writeAt` exists because a chunk spans every channel, while ingest decodes one
 * channel at a time: channel `c`'s sub-blocks are scattered through the file at a
 * fixed stride, so its writes are positioned rather than sequential. Gaps left by
 * channels not yet written read back as zeros, which zarr treats as fill_value.
 */
export interface PackedWriter {
  /** Append bytes at the current position. */
  write(bytes: ArrayBufferView): void
  /** Write bytes at an absolute offset, extending the file if needed. */
  writeAt(bytes: ArrayBufferView, offset: number): void
  /**
   * Grow the file to at least `bytes` on close, never shrink it. Needed because the
   * highest offset written depends on which channel wrote last: with only the first of
   * several channels ingested, the file stops short of the final chunk's end and the
   * service worker would 404 that chunk until a later channel extends it.
   */
  ensureSize(bytes: number): void
  /** Highest offset written so far. */
  readonly bytesWritten: number
  close(): Promise<void>
}

/**
 * View the same memory as a Uint8Array without copying. Cast through `ArrayBuffer`:
 * ArrayBufferView's `.buffer` is typed as the more general `ArrayBufferLike` (it
 * could be a SharedArrayBuffer), but our callers only ever pass plain ArrayBuffers.
 */
function asBytes(view: ArrayBufferView): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength
  )
}

export async function openPackedWriter(path: string): Promise<PackedWriter> {
  const { dir, name } = splitPath(path)
  const dirHandle = await resolveDir(dir, true)
  if (!dirHandle) throw new Error(`cannot resolve directory for ${path}`)
  const fileHandle = await dirHandle.getFileHandle(name, { create: true })

  // createSyncAccessHandle() only exists inside a worker. It is the whole reason
  // chunks are packed into one file per level: it turns ~10k open/write/close
  // round-trips into one open plus a tight loop of synchronous writes. Always
  // preferred; the ingest worker's hot loop depends on this branch being taken.
  //
  // Feature-detect via `typeof ... === "function"`, not `"createSyncAccessHandle"
  // in fileHandle`: the WebWorker lib declares the method as always-present (not
  // optional), so TS would narrow the false branch of an `in` check to `never` and
  // reject the main-thread fallback below as dead code.
  if (typeof fileHandle.createSyncAccessHandle === "function") {
    const handle = await fileHandle
      .createSyncAccessHandle()
      .catch((err: unknown) => {
        throw opfsFailure(err, "opening", path)
      })
    let bytesWritten = 0
    let target = 0

    // Every call through the handle is annotated, not just the open. Running out of
    // room happens *during* the writes -- that is where the bytes are -- and the raw
    // DOMException says only "Failed to execute 'write' on
    // 'FileSystemSyncAccessHandle': No space available for this operation": no fault
    // name, and no hint which of a hundred chunk files it was.
    const guard = <T>(action: string, fn: () => T, written?: number): T => {
      try {
        return fn()
      } catch (err) {
        throw opfsFailure(err, action, path, written)
      }
    }

    return {
      write(bytes) {
        const view = asBytes(bytes)
        guard(
          "writing",
          () => handle.write(view, { at: bytesWritten }),
          bytesWritten
        )
        bytesWritten += view.byteLength
      },
      writeAt(bytes, offset) {
        const view = asBytes(bytes)
        guard("writing", () => handle.write(view, { at: offset }))
        bytesWritten = Math.max(bytesWritten, offset + view.byteLength)
      },
      ensureSize(bytes) {
        target = Math.max(target, bytes)
      },
      get bytesWritten() {
        return bytesWritten
      },
      async close() {
        // Closed even when flushing fails, or the handle stays locked and every later
        // attempt on this file fails for a different and more confusing reason.
        try {
          if (target > bytesWritten)
            guard("resizing", () => handle.truncate(target))
          guard("flushing", () => handle.flush())
        } finally {
          handle.close()
        }
      },
    }
  }

  // Fallback for the main thread, which has no sync access handle. write() must
  // stay synchronous per the PackedWriter contract, so each call's bytes are
  // copied into a queue (the caller's buffer may be reused or transferred right
  // after write() returns) and the actual async writes happen in close().
  // Memory cost: the whole file's bytes are held in memory a second time (once
  // queued here, once inside the stream) until close() resolves. That is fine
  // for the tiny JSON-adjacent writes the main thread does; the ingest worker
  // never takes this path.
  const writable = await fileHandle.createWritable().catch((err: unknown) => {
    throw opfsFailure(err, "opening", path)
  })
  const queue: Array<{ bytes: Uint8Array<ArrayBuffer>; at: number }> = []
  let bytesWritten = 0
  let target = 0
  return {
    write(bytes) {
      const view = asBytes(bytes)
      queue.push({ bytes: view.slice(), at: bytesWritten })
      bytesWritten += view.byteLength
    },
    writeAt(bytes, offset) {
      const view = asBytes(bytes)
      queue.push({ bytes: view.slice(), at: offset })
      bytesWritten = Math.max(bytesWritten, offset + view.byteLength)
    },
    ensureSize(bytes) {
      target = Math.max(target, bytes)
    },
    get bytesWritten() {
      return bytesWritten
    },
    async close() {
      for (const chunk of queue) {
        await writable.write({
          type: "write",
          position: chunk.at,
          data: chunk.bytes,
        })
      }
      if (target > bytesWritten) await writable.truncate(target)
      await writable.close()
    },
  }
}

/** Delete the whole zarr tree. Used by the UI's "clear cached data" button. */
export async function clearAllDatasets(): Promise<void> {
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(ZARR_ROOT, { recursive: true })
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/** Delete one dataset. */
export async function removeDataset(datasetId: string): Promise<void> {
  const zarrRoot = await resolveDir(ZARR_ROOT, false)
  if (!zarrRoot) return
  try {
    await zarrRoot.removeEntry(datasetId, { recursive: true })
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/**
 * Total bytes a dataset occupies, by walking it.
 *
 * Used when the marker does not record a size -- a dataset written before markers
 * existed, or one whose conversion died before writing one. Costs one handle per file,
 * which for a five-level pyramid over a few channels is dozens, not thousands.
 */
export async function datasetSize(datasetId: string): Promise<number> {
  const dir = await resolveDir(datasetPath(datasetId), false)
  return dir ? sumDirectory(dir) : 0
}

async function sumDirectory(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0
  for await (const handle of (
    dir as unknown as {
      values(): AsyncIterable<FileSystemDirectoryHandle | FileSystemFileHandle>
    }
  ).values()) {
    try {
      if (handle.kind === "directory") {
        total += await sumDirectory(handle as FileSystemDirectoryHandle)
      } else {
        total += (await (handle as FileSystemFileHandle).getFile()).size
      }
    } catch {
      // A file removed while we walk is one we do not have to count.
    }
  }
  return total
}

/** Dataset ids currently in OPFS. */
export async function listDatasets(): Promise<string[]> {
  const zarrRoot = await resolveDir(ZARR_ROOT, false)
  if (!zarrRoot) return []
  const ids: string[] = []
  for await (const name of (
    zarrRoot as unknown as FileSystemDirectoryHandleIterable
  ).keys()) {
    ids.push(name)
  }
  return ids
}

export async function storageEstimate(): Promise<{
  usage: number
  quota: number
}> {
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}

/** Ask the browser to make storage persistent, reducing eviction risk. Never throws. */
export async function requestPersist(): Promise<boolean> {
  try {
    return await navigator.storage.persist()
  } catch (err) {
    console.error("requestPersist failed", err)
    return false
  }
}

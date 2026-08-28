/// <reference types="vite/client" />

// Local type shims for packages that ship no declarations.

declare module "@janelia/react-neuroglancer" {
  import type React from "react"
  export const NeuroglancerViewer: React.ComponentType<{
    /** Neuroglancer state as a JSON *string*; parsed once on mount. */
    initialState?: string
    className?: string
    width?: string
    height?: string
    initialViewerOptions?: Record<string, unknown>
    onViewerInit?: (viewer: NeuroglancerViewerInstance) => void
  }>
  /**
   * What the hook reports on every `viewer.state.changed`. `raw` is the viewer's own
   * `toJSON()` -- the same JSON Neuroglancer writes into its URL fragment -- and the
   * fields beside it are a convenience projection of it.
   */
  export interface NeuroglancerSnapshot {
    position?: number[]
    orientation?: number[]
    zoom?: number
    layers?: Array<{ name?: string; type?: string; visible?: boolean }>
    raw?: Record<string, unknown>
  }

  /**
   * `setState` merges: it replaces `layers` wholesale when given, folds
   * position/orientation/zoom into the navigation state, and leaves everything else
   * as it was. There is no partial-layer update, which is why a caller must always
   * pass a layer built from current state rather than from defaults.
   */
  export function useNeuroglancer(viewer: NeuroglancerViewerInstance | null): {
    snapshot: NeuroglancerSnapshot
    setState: (
      updater:
        Record<string, unknown> | ((state: Record<string, unknown>) => unknown)
    ) => void
  }
  export type NeuroglancerViewerInstance = {
    state: { restoreState: (state: unknown) => void }
  } & Record<string, unknown>
}

declare module "@janelia/web-h5j-loader" {
  /** Opaque jsfive File handle. */
  export type H5JFile = {
    filename: string
    attrs: Record<string, unknown>
    get: (path: string) => unknown
  }
  export function openH5J(src: File | string): Promise<H5JFile>
  export function getH5JAttrs(file: H5JFile): Record<string, unknown>
  export function createFFmpegForEnv(): Promise<FFmpegInstance>
  export function readH5JChannelUint8(
    channelName: string,
    file: H5JFile,
    onProgress?: (p: { ratio: number }) => void,
    ffmpeg?: FFmpegInstance
  ): Promise<Uint8Array | null>
  export function readH5JChannelUint16(
    channelName: string,
    file: H5JFile,
    onProgress?: (p: { ratio: number }) => void,
    ffmpeg?: FFmpegInstance
  ): Promise<Uint16Array | null>
  export type FFmpegInstance = {
    load: () => Promise<void>
    isLoaded: () => boolean
    setProgress: (cb: (p: { ratio: number }) => void) => void
    run: (...args: string[]) => Promise<void>
    /**
     * Bridge to ffmpeg.wasm's in-memory (emscripten MEMFS) filesystem:
     * `FS(method, ...args)` calls emscripten's `FS[method]`. Overloaded for the
     * methods this app uses so callers get real types rather than casts; the final
     * signature keeps the rest of the API reachable.
     *
     * `readFile` allocates a fresh `Uint8Array` and copies into it (verified in
     * `@ffmpeg/core`'s `ffmpeg-core.js`), so the value it returns does NOT alias the
     * file and stays valid after an `unlink`.
     */
    FS: {
      (action: "readFile", path: string): Uint8Array
      (action: "writeFile", path: string, data: Uint8Array): void
      (action: "unlink", path: string): void
      (action: "readdir", path: string): string[]
      (action: string, ...args: unknown[]): unknown
    }
    exit: () => void
  }
}

declare module "@ffmpeg/ffmpeg" {
  import type { FFmpegInstance } from "@janelia/web-h5j-loader"
  export function createFFmpeg(options?: {
    corePath?: string
    log?: boolean
    logger?: (msg: { type: string; message: string }) => void
    progress?: (p: { ratio: number }) => void
  }): FFmpegInstance
  export function fetchFile(src: unknown): Promise<Uint8Array>
}

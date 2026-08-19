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
  export function useNeuroglancer(viewer: NeuroglancerViewerInstance | null): {
    snapshot: unknown
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
    FS: (action: string, ...args: unknown[]) => Uint8Array
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

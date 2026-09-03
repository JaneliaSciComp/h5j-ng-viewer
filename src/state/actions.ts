// Action creators and the discriminated union every reducer case is checked against.
//
// Clio bundles ~30 dispatch wrappers into an `actions` prop threaded through every
// component (`WorkSpaces.jsx` mapDispatchToProps). We keep the action creators but not
// the bundle: components take `dispatch` from the store hook and import the creators
// they use, so adding an action does not mean editing a prop-drilling table.

import C from "@/state/constants"
import type { ChannelStats } from "@/lib/stats"
import type { H5JInfo, IngestPhase, ResolvedDims } from "@/types"
import type { LaunchParams } from "@/lib/url"

/**
 * Phases the UI shows. `fetching` and `decoding` are ours rather than the ingest
 * worker's: the worker only hears about a channel once it has been decoded.
 */
export type Phase =
  | IngestPhase
  | "fetching"
  | "decoding"
  // Reclaiming space before a conversion can start. Its own phase because it can take
  // minutes on a large cache -- deleting gigabytes is not instant -- and without one
  // the bar sat on the previous label while the app appeared to have stalled.
  | "evicting"
  | "idle"

export type Action =
  | { type: typeof C.LAUNCH_PARSED; launch: LaunchParams }
  | { type: typeof C.SOURCE_OPENING }
  | {
      type: typeof C.SOURCE_OPENED
      info: H5JInfo
      name: string
      h5jUrl: string | null
    }
  | { type: typeof C.SOURCE_FAILED; message: string }
  | { type: typeof C.VISIBILITY_CHANGED; visible: boolean[] }
  | { type: typeof C.COLOR_CHANGED; channelIndex: number; color: string }
  | { type: typeof C.OPACITY_CHANGED; channelIndex: number; opacity: number }
  | { type: typeof C.VOLUME_RENDERING_TOGGLED; on: boolean }
  | { type: typeof C.PROJECTION_SAMPLES_CHANGED; samples: number }
  | { type: typeof C.CHANNEL_PICKED; channelIndex: number }
  | { type: typeof C.INGEST_STARTED; channelCount: number }
  | { type: typeof C.INGEST_CHANNEL; channelIndex: number; label: string }
  | { type: typeof C.INGEST_PHASE; phase: Phase; detail?: string }
  | { type: typeof C.INGEST_PROGRESS; fraction: number | null }
  | { type: typeof C.INGEST_DIMS; dims: ResolvedDims }
  | { type: typeof C.INGEST_STATS; channelIndex: number; stats: ChannelStats }
  | { type: typeof C.CHANNEL_READY; channelIndex: number }
  | { type: typeof C.INGEST_WARNINGS; warnings: string[] }
  | { type: typeof C.INGEST_DETAILS; details: string[] }
  | { type: typeof C.INGEST_DONE }
  | { type: typeof C.INGEST_FAILED; message: string }
  | {
      type: typeof C.VIEWER_READY
      datasetId: string
      viewerState: string
      geometry: string
    }
  | { type: typeof C.STORAGE_UPDATED; usage: number; quota: number }
  | { type: typeof C.PERSIST_RESULT; persisted: boolean }
  | { type: typeof C.CLEAR_STARTED }
  | { type: typeof C.CLEAR_FINISHED }
  | {
      type: typeof C.CAMERA_MOVED
      position: [number, number, number] | null
      zoom: number | null
    }
  | { type: typeof C.SETTINGS_OPENED; open: boolean }
  | { type: typeof C.EVICTION_PERCENT_CHANGED; percent: number }

/**
 * How the ingest pipeline talks to the store. Deliberately not `React.Dispatch`:
 * `lib/ingest.ts` has no business importing React, and this way it can be driven
 * directly from a test.
 */
export type Dispatch = (action: Action) => void

export const launchParsed = (launch: LaunchParams): Action => ({
  type: C.LAUNCH_PARSED,
  launch,
})

export const sourceOpening = (): Action => ({ type: C.SOURCE_OPENING })

/** `h5jUrl` is null for a local file: there is nothing to put in a shareable link. */
export const sourceOpened = (
  info: H5JInfo,
  name: string,
  h5jUrl: string | null
): Action => ({ type: C.SOURCE_OPENED, info, name, h5jUrl })

export const sourceFailed = (message: string): Action => ({
  type: C.SOURCE_FAILED,
  message,
})

export const visibilityChanged = (visible: boolean[]): Action => ({
  type: C.VISIBILITY_CHANGED,
  visible,
})

export const colorChanged = (channelIndex: number, color: string): Action => ({
  type: C.COLOR_CHANGED,
  channelIndex,
  color,
})

export const opacityChanged = (
  channelIndex: number,
  opacity: number
): Action => ({ type: C.OPACITY_CHANGED, channelIndex, opacity })

export const volumeRenderingToggled = (on: boolean): Action => ({
  type: C.VOLUME_RENDERING_TOGGLED,
  on,
})

export const projectionSamplesChanged = (samples: number): Action => ({
  type: C.PROJECTION_SAMPLES_CHANGED,
  samples,
})

/**
 * Point the bar's per-channel controls at a channel. Showing it as well is the caller's
 * job, not the reducer's: right-clicking a chip both picks and reveals, but picking the
 * first ready channel automatically must not turn anything on.
 */
export const channelPicked = (channelIndex: number): Action => ({
  type: C.CHANNEL_PICKED,
  channelIndex,
})

/** One channel's data is now readable through the service worker. */
export const channelReady = (channelIndex: number): Action => ({
  type: C.CHANNEL_READY,
  channelIndex,
})

export const ingestStarted = (channelCount: number): Action => ({
  type: C.INGEST_STARTED,
  channelCount,
})

export const ingestChannel = (channelIndex: number, label: string): Action => ({
  type: C.INGEST_CHANNEL,
  channelIndex,
  label,
})

export const ingestPhase = (phase: Phase, detail?: string): Action => ({
  type: C.INGEST_PHASE,
  phase,
  detail,
})

export const ingestProgress = (fraction: number | null): Action => ({
  type: C.INGEST_PROGRESS,
  fraction,
})

export const ingestDims = (dims: ResolvedDims): Action => ({
  type: C.INGEST_DIMS,
  dims,
})

export const ingestStats = (
  channelIndex: number,
  stats: ChannelStats
): Action => ({ type: C.INGEST_STATS, channelIndex, stats })

export const ingestWarnings = (warnings: string[]): Action => ({
  type: C.INGEST_WARNINGS,
  warnings,
})

export const ingestDetails = (details: string[]): Action => ({
  type: C.INGEST_DETAILS,
  details,
})

export const ingestDone = (): Action => ({ type: C.INGEST_DONE })

export const ingestFailed = (message: string): Action => ({
  type: C.INGEST_FAILED,
  message,
})

export const viewerReady = (
  datasetId: string,
  viewerState: string,
  geometry: string
): Action => ({ type: C.VIEWER_READY, datasetId, viewerState, geometry })

export const storageUpdated = (usage: number, quota: number): Action => ({
  type: C.STORAGE_UPDATED,
  usage,
  quota,
})

export const persistResult = (persisted: boolean): Action => ({
  type: C.PERSIST_RESULT,
  persisted,
})

export const clearStarted = (): Action => ({ type: C.CLEAR_STARTED })

export const clearFinished = (): Action => ({ type: C.CLEAR_FINISHED })

/**
 * Where the viewer is looking now. Dispatched from the viewer's own state, never from
 * a control, so it only ever flows one way: Neuroglancer to the store to the URL.
 */
export const cameraMoved = (
  position: [number, number, number] | null,
  zoom: number | null
): Action => ({ type: C.CAMERA_MOVED, position, zoom })

export const settingsOpened = (open: boolean): Action => ({
  type: C.SETTINGS_OPENED,
  open,
})

export const evictionPercentChanged = (percent: number): Action => ({
  type: C.EVICTION_PERCENT_CHANGED,
  percent,
})

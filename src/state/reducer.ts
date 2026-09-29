// The single reducer, and the state shape it owns.
//
// Two rules this file exists to enforce, both learned from Clio's viewer slice:
//
//   1. It is PURE. It never reads live Neuroglancer state, never touches OPFS, and
//      never calls a module-level accessor. Clio's reducer calls
//      `getNeuroglancerViewerState()` behind a mutable module flag, which makes the
//      result depend on render order and has accumulated defensive workarounds for
//      state Neuroglancer itself will not accept. Everything here is a function of
//      (state, action) alone, which is also what will make undo/redo tractable.
//   2. Plain objects, no Immutable.js. Structural sharing buys nothing at this size,
//      and typed plain objects mean the compiler checks every field access.

import C from "@/state/constants"
import type { Action, Phase } from "@/state/actions"
import type { ChannelStats } from "@/lib/stats"
import type { ChannelControls, H5JInfo, ResolvedDims } from "@/types"
import { NO_PARAMS, visibilityFor } from "@/lib/url"
import type { LaunchParams } from "@/lib/url"
import { defaultChannelColors } from "@/lib/h5j"
import {
  DEFAULT_PROJECTION_SAMPLES,
  samplesForStep,
  stepForSamples,
} from "@/lib/projection"
import { applyColorOverrides } from "@/lib/ingest"
import { clampEvictionPercent, loadEvictionPercent } from "@/lib/prefs"

export interface AppState {
  /**
   * What the address bar asked for. Kept verbatim so a URL rewrite can preserve the
   * parts of the launch this build does not own, and so the view overrides are still
   * to hand when the viewer state is finally built.
   */
  launch: LaunchParams

  /** What the user asked to load, before any decoding. */
  source: {
    /** Display name: the file name, not the whole URL. */
    name: string
    /** The URL it came from, or null for a local file, which cannot be shared. */
    h5jUrl: string | null
    /** Container metadata, once the H5J has been opened. */
    info: H5JInfo | null
  }

  /** What the user can change about the rendering. One entry per container channel. */
  controls: ChannelControls

  /** What has actually been converted and is being served out of OPFS. */
  dataset: {
    id: string | null
    /** Geometry reconciled against the decoded byte count. */
    dims: ResolvedDims | null
    /** Measured per channel, in c-axis order; sparse while ingest is running. */
    stats: Array<ChannelStats | undefined>
    /**
     * Per channel: is its data readable yet? Every channel is converted, but the
     * hidden ones arrive after the visible ones, so a chip must be able to say
     * "converting" rather than pretending it can be shown.
     */
    ready: boolean[]
    /** Neuroglancer state JSON, built once the first channel is readable. */
    viewerState: string | null
    /** One-line geometry summary for the top bar. */
    geometry: string | null
  }

  /** Progress and diagnostics for the conversion in flight. */
  ingest: {
    phase: Phase
    /** 0..1, or null when the phase has no meaningful fraction. */
    fraction: number | null
    /** e.g. "Channel_0 (1 of 3)" */
    channelLabel?: string
    /**
     * Which channel is being converted right now, or null between channels. The chip
     * for this one shows progress; the ones merely queued do not.
     */
    channelIndex: number | null
    /** e.g. "Level 2 of 4" */
    detail?: string
    warnings: string[]
    /** Informational lines: per-channel intensity ranges, probe results. */
    details: string[]
    error: string | null
  }

  storage: {
    usage: number
    quota: number
    persisted: boolean
    clearing: boolean
    /**
     * How full storage may get before old volumes are discarded, as a percentage of
     * the quota. A preference rather than session state, so it is seeded from
     * localStorage and written back on change.
     */
    evictionPercent: number
  }

  /**
   * Where the viewer is looking, mirrored from Neuroglancer so the address bar can
   * carry it. Only the parts a link needs are kept -- storing the whole viewer state
   * would mean copying a large object on every mouse move for no reader.
   */
  camera: {
    position: [number, number, number] | null
    zoom: number | null
    /**
     * A position the Z-slice slider asked for, waiting to be pushed to the live viewer.
     * Set only by `SLICE_SCRUBBED` and cleared by `CAMERA_APPLIED`, so it is the one
     * signal that says "this move came from us" -- a snapshot-driven `CAMERA_MOVED` never
     * sets it, which is what keeps the read and write camera paths from looping.
     */
    pendingPosition: [number, number, number] | null
    /**
     * The scale at which the current view was fitted to its pane on load, or null when no
     * fit has happened (a shared link pinned a zoom, so the fit was skipped). The URL
     * writer compares `zoom` against this to tell an untouched default from a chosen zoom,
     * and persists only the latter.
     */
    defaultZoom: number | null
  }

  ui: {
    /** Whether the settings dialog is showing. */
    settingsOpen: boolean
    /**
     * Which channel the bar's eye and color swatch act on, or null when no channel is
     * ready yet. This is UI focus rather than a rendering property, which is why it
     * lives here and not in `controls`: undo must not move the user's selection out
     * from under them, and picking a channel changes nothing about the image.
     */
    pickedChannel: number | null
  }
}

export const initialState: AppState = {
  launch: NO_PARAMS,
  source: { name: "", h5jUrl: null, info: null },
  controls: {
    visible: [],
    colors: [],
    opacity: [],
    contrast: [],
    volumeRendering: false,
    projectionSamples: DEFAULT_PROJECTION_SAMPLES,
  },
  dataset: {
    id: null,
    dims: null,
    stats: [],
    ready: [],
    viewerState: null,
    geometry: null,
  },
  ingest: {
    phase: "idle",
    fraction: null,
    channelIndex: null,
    warnings: [],
    details: [],
    error: null,
  },
  storage: {
    usage: 0,
    quota: 0,
    persisted: false,
    clearing: false,
    evictionPercent: loadEvictionPercent(),
  },
  camera: {
    position: null,
    zoom: null,
    pendingPosition: null,
    defaultZoom: null,
  },
  ui: { settingsOpen: false, pickedChannel: null },
}

/**
 * Everything a previous load left behind. Applied whenever a new source is opened or a
 * new conversion starts, so diagnostics can never accumulate across runs -- the old
 * code appended to `channelStats`/`warnings` and reset neither, so a second load showed
 * the first load's numbers.
 */
const clearedForNewRun = {
  dataset: initialState.dataset,
  ingest: initialState.ingest,
}

/** Same, for the parts of `ui` that describe the run rather than the chrome. */
const uiClearedForNewRun = { pickedChannel: null }

/** A copy with one entry replaced, so a reducer case never mutates what it was given. */
function replaceAt<T>(values: T[], index: number, value: T): T[] {
  const next = [...values]
  next[index] = value
  return next
}

/**
 * The rendering controls a freshly opened container starts with: `chs` decides what is
 * visible, `channel_spec` and `col` decide the colors, and nothing is measured yet.
 *
 * Colors are indexed by the channel's own position in the container, so hiding one
 * never shifts another's color.
 */
export function initialControls(
  info: H5JInfo,
  launch: LaunchParams
): ChannelControls {
  const count = info.channels.length
  return {
    visible: visibilityFor(count, launch.channels),
    colors: applyColorOverrides(defaultChannelColors(count), launch.colors),
    opacity: Array.from({ length: count }, () => 1),
    contrast: Array.from({ length: count }, () => undefined),
    // Not launch-controlled: it costs GPU time, so it starts off and the user asks.
    volumeRendering: false,
    projectionSamples: DEFAULT_PROJECTION_SAMPLES,
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case C.LAUNCH_PARSED:
      return { ...state, launch: action.launch }

    case C.SOURCE_OPENING:
      return {
        ...state,
        ...clearedForNewRun,
        source: { ...state.source, info: null },
        controls: initialState.controls,
        ui: { ...state.ui, ...uiClearedForNewRun },
        // Downloading the container and parsing it can take a while on a large file,
        // and nothing else reports it: the ingest worker does not hear about a channel
        // until it has already been decoded.
        ingest: { ...initialState.ingest, phase: "fetching" },
      }

    case C.SOURCE_OPENED:
      return {
        ...state,
        source: {
          ...state.source,
          info: action.info,
          name: action.name,
          h5jUrl: action.h5jUrl,
        },
        controls: initialControls(action.info, state.launch),
        ingest: { ...state.ingest, phase: "idle", detail: undefined },
      }

    case C.SOURCE_FAILED:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          error: action.message,
          phase: "idle",
          detail: undefined,
        },
      }

    case C.VISIBILITY_CHANGED:
      return {
        ...state,
        controls: { ...state.controls, visible: action.visible },
      }

    case C.COLOR_CHANGED:
      return {
        ...state,
        controls: {
          ...state.controls,
          colors: replaceAt(
            state.controls.colors,
            action.channelIndex,
            action.color
          ),
        },
      }

    case C.OPACITY_CHANGED:
      return {
        ...state,
        controls: {
          ...state.controls,
          opacity: replaceAt(
            state.controls.opacity,
            action.channelIndex,
            action.opacity
          ),
        },
      }

    case C.VOLUME_RENDERING_TOGGLED:
      return {
        ...state,
        controls: { ...state.controls, volumeRendering: action.on },
      }

    case C.PROJECTION_SAMPLES_CHANGED:
      return {
        ...state,
        controls: {
          ...state.controls,
          // Snapped to the ladder here rather than trusted from the caller, so a value
          // out of Neuroglancer's range can never reach it -- its own restoreState would
          // silently fall back to the blockiest setting instead of reporting a problem.
          projectionSamples: samplesForStep(stepForSamples(action.samples)),
        },
      }

    case C.CHANNEL_PICKED:
      return {
        ...state,
        ui: { ...state.ui, pickedChannel: action.channelIndex },
      }

    case C.INGEST_STARTED:
      return {
        ...state,
        ...clearedForNewRun,
        ui: { ...state.ui, ...uiClearedForNewRun },
      }

    case C.INGEST_CHANNEL:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          channelIndex: action.channelIndex,
          channelLabel: action.label,
        },
      }

    case C.INGEST_PHASE:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          phase: action.phase,
          detail: action.detail,
        },
      }

    case C.INGEST_PROGRESS:
      return {
        ...state,
        ingest: { ...state.ingest, fraction: action.fraction },
      }

    case C.INGEST_DIMS:
      return { ...state, dataset: { ...state.dataset, dims: action.dims } }

    case C.CHANNEL_READY: {
      const ready = [...state.dataset.ready]
      ready[action.channelIndex] = true
      return {
        ...state,
        dataset: { ...state.dataset, ready },
        ui: {
          ...state.ui,
          // The first channel to become readable adopts the controls, so the eye and
          // the swatch always have a target once anything can be shown at all. Later
          // arrivals leave the user's own pick alone.
          pickedChannel: state.ui.pickedChannel ?? action.channelIndex,
        },
      }
    }

    case C.INGEST_STATS: {
      const stats = [...state.dataset.stats]
      stats[action.channelIndex] = action.stats
      // The measurement is also this channel's display range, unless it is degenerate:
      // a zero-width invlerp renders nothing at all, so leave the hole and let
      // buildLayer fall back to the dtype range.
      const { lower, upper } = action.stats
      const contrast =
        upper > lower
          ? replaceAt(state.controls.contrast, action.channelIndex, [
              lower,
              upper,
            ] as [number, number])
          : state.controls.contrast
      return {
        ...state,
        dataset: { ...state.dataset, stats },
        controls: { ...state.controls, contrast },
      }
    }

    case C.INGEST_WARNINGS:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          warnings: [...state.ingest.warnings, ...action.warnings],
        },
      }

    case C.INGEST_DETAILS:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          details: [...state.ingest.details, ...action.details],
        },
      }

    case C.INGEST_DONE:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          phase: "done",
          fraction: null,
          channelIndex: null,
          channelLabel: undefined,
          detail: undefined,
        },
      }

    case C.INGEST_FAILED:
      return {
        ...state,
        ingest: {
          ...state.ingest,
          error: action.message,
          phase: "idle",
          fraction: null,
        },
      }

    case C.VIEWER_READY:
      return {
        ...state,
        dataset: {
          ...state.dataset,
          id: action.datasetId,
          viewerState: action.viewerState,
          geometry: action.geometry,
        },
      }

    case C.STORAGE_UPDATED:
      return {
        ...state,
        storage: { ...state.storage, usage: action.usage, quota: action.quota },
      }

    case C.PERSIST_RESULT:
      return {
        ...state,
        storage: { ...state.storage, persisted: action.persisted },
      }

    case C.CLEAR_STARTED:
      return { ...state, storage: { ...state.storage, clearing: true } }

    case C.CLEAR_FINISHED:
      return {
        ...state,
        ...clearedForNewRun,
        ui: { ...state.ui, ...uiClearedForNewRun },
        storage: { ...state.storage, clearing: false },
      }

    case C.CAMERA_MOVED:
      // Preserves `pendingPosition`: a snapshot from the viewer must not clear a scrub the
      // wire has not applied yet. `CAMERA_APPLIED` is what clears it, right after the push.
      return {
        ...state,
        camera: {
          ...state.camera,
          position: action.position,
          zoom: action.zoom,
        },
      }

    case C.SLICE_SCRUBBED: {
      // Only depth moves, so the current x and y are kept. Before the viewer has reported
      // a position there is nothing to keep, so the scrub is dropped rather than guessed --
      // the slider is disabled in that window, so this is belt and braces.
      const current = state.camera.position
      if (!current) return state
      const next: [number, number, number] = [current[0], current[1], action.z]
      // Set optimistically as well as queued, so the slider tracks the drag rather than
      // waiting for the round-trip out to Neuroglancer and back through a snapshot.
      return {
        ...state,
        camera: { ...state.camera, position: next, pendingPosition: next },
      }
    }

    case C.CAMERA_APPLIED:
      return {
        ...state,
        camera: { ...state.camera, pendingPosition: null },
      }

    case C.VIEW_FITTED:
      // Records the fitted scale and adopts it as the current zoom in the same step, so
      // there is no window where the stale zoom looks like a deliberate one to the URL
      // writer before the viewer's own snapshot catches up.
      return {
        ...state,
        camera: {
          ...state.camera,
          zoom: action.zoom,
          defaultZoom: action.zoom,
        },
      }

    case C.EVICTION_PERCENT_CHANGED:
      return {
        ...state,
        storage: {
          ...state.storage,
          // Clamped here rather than trusted from the input, so a typed-in 5000 or a
          // blanked field cannot turn into a budget of five thousand percent or NaN.
          evictionPercent: clampEvictionPercent(action.percent),
        },
      }

    case C.SETTINGS_OPENED:
      return { ...state, ui: { ...state.ui, settingsOpen: action.open } }

    default:
      return state
  }
}

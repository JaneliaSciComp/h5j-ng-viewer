// Derived reads. Anything a component computes from more than one field of the state
// belongs here rather than in the component, so the rule lives in one place and can be
// tested without rendering.

import { projectedOutputBytes, VOXEL_BITS } from "@/lib/h5j"
import type { LayerDataset } from "@/lib/ngstate"
import type { AppState } from "@/state/reducer"

/** True while a conversion is in flight. Idle and done are resting states. */
export function isBusy(state: AppState): boolean {
  return state.ingest.phase !== "idle" && state.ingest.phase !== "done"
}

/**
 * Projected output size for the pending conversion, or null when there is nothing
 * pending. Shown before decoding starts, because the input file size is not a useful
 * predictor -- H5J is H.265-compressed, so a small file can decode to many times its
 * size.
 */
export function projectedBytes(state: AppState): number | null {
  const { info } = state.source
  if (!info || state.dataset.viewerState) return null
  // Every channel is converted, not just the visible ones.
  return projectedOutputBytes(
    info.nominalSize,
    info.channels.length,
    VOXEL_BITS
  )
}

/**
 * The channel the bar's eye and swatch act on, with everything a control needs to
 * render, or null when nothing is ready yet and those controls should be disabled.
 *
 * Guards against a stale pick: a channel index that no longer exists, or one that is not
 * readable, must not be handed to a control as though it were editable.
 */
export function pickedChannel(state: AppState): {
  index: number
  name: string
  visible: boolean
  color: string
} | null {
  const { pickedChannel: index } = state.ui
  const channels = state.source.info?.channels
  if (index === null || !channels || !channels[index]) return null
  if (state.dataset.ready[index] !== true) return null
  return {
    index,
    name: channels[index].name,
    visible: state.controls.visible[index] !== false,
    color: state.controls.colors[index],
  }
}

/**
 * Everything `buildLayer` needs about where the data is, or null before there is any.
 * Assembled here so the component that pushes state into Neuroglancer does not have to
 * know which corners of the store the pieces live in.
 */
export function layerDataset(
  state: AppState,
  origin: string
): LayerDataset | null {
  const { id, dims, ready } = state.dataset
  const info = state.source.info
  if (!id || !dims || !info) return null
  return {
    origin,
    datasetId: id,
    datasetName: state.source.name || id,
    voxelSize: dims.voxelSize,
    bits: VOXEL_BITS,
    channelNames: info.channels.map((channel) => channel.name),
    ready: info.channels.map((_, index) => ready[index] === true),
  }
}

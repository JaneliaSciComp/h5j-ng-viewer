import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import {
  NeuroglancerViewer,
  useNeuroglancer,
} from "@janelia/react-neuroglancer"
import type { NeuroglancerViewerInstance } from "@janelia/react-neuroglancer"
import { appliesToLiveLayer, buildLayer } from "@/lib/ngstate"
import { cameraApplied, cameraMoved, viewFitted } from "@/state/actions"
import { useAppState, useDispatch } from "@/state/context"
import { layerDataset } from "@/state/selectors"

/**
 * Neuroglancer, and the wires that connect it to the store.
 *
 * The wires run in opposite directions and never meet:
 *
 *   controls  ->  buildLayer  ->  setState        what the user changes in the bar
 *   camera    ->  snapshot    ->  store  ->  URL  where the user has navigated to
 *
 * Keeping them one-way each is what stops a feedback loop: the push reacts to
 * `controls`, which the snapshot never writes, and the pull reacts to the snapshot,
 * which the push never reads.
 *
 * `initialState` is parsed once when the viewer mounts, so every later change has to
 * arrive through `setState`. That is the whole reason this component exists.
 */
export function ViewerPane(props: { origin: string }): ReactElement {
  const { dataset } = useAppState()

  // State rather than a ref: the sync below must not mount until there is a viewer for
  // it to subscribe to, and that means a render.
  const [viewer, setViewer] = useState<NeuroglancerViewerInstance | null>(null)

  return (
    <>
      <NeuroglancerViewer
        key={dataset.id ?? "none"}
        initialState={dataset.viewerState ?? undefined}
        onViewerInit={setViewer}
        className="ng"
        width="100%"
        height="100%"
      />
      {/* Split out so `useNeuroglancer` is never called with a null viewer: its store
          returns a fresh object from getSnapshot in that case, which React reports as an
          uncached snapshot and re-renders over. */}
      {viewer ? <ViewerSync viewer={viewer} origin={props.origin} /> : null}
    </>
  )
}

function ViewerSync(props: {
  viewer: NeuroglancerViewerInstance
  origin: string
}): null {
  const state = useAppState()
  const dispatch = useDispatch()
  // Only the snapshot comes from the wrapper. Layer changes land on live layers, and the
  // Z-slice scrub goes back through `viewer.state.restoreState` below -- not the wrapper's
  // `setState`, which rebuilds the coordinate space and drops the view into a corner.
  const { snapshot } = useNeuroglancer(props.viewer)

  const { controls, dataset } = state
  const layerTarget = layerDataset(state, props.origin)

  // What Neuroglancer currently has, one entry per channel. Compared before pushing, so
  // an unrelated render cannot cause a redundant update -- and so the layers already
  // inside `initialState` are not immediately pushed back on mount.
  const lastPushed = useRef<Array<Record<string, unknown>> | null>(null)

  // The dataset the cross-section has already been fitted for, so the fit happens once per
  // load and never fights the user's own zooming afterwards.
  const fittedFor = useRef<string | null>(null)

  useEffect(() => {
    // Seeded from the very state Neuroglancer parsed, not guessed. Assuming instead that
    // the first layers computed here must be what it already has is wrong whenever a
    // channel finishes converting between the mount and this effect's first run: the
    // difference would be diffed away silently and that channel would never appear.
    lastPushed.current = initialLayers(dataset.viewerState)
  }, [dataset.id, dataset.viewerState])

  useEffect(() => {
    if (!layerTarget) return
    const layers = layerTarget.channelNames.map((_, channel) =>
      buildLayer(controls, layerTarget, channel)
    )
    const previous = lastPushed.current

    if (previous === null || previous.length !== layers.length) {
      // No usable record of what Neuroglancer has -- adopt the current layers rather
      // than push a diff against a guess.
      lastPushed.current = layers
      return
    }
    lastPushed.current = layers

    // Applied per channel, and never by replacing a layer: replacing one makes
    // Neuroglancer re-resolve its data source and rebuild the coordinate space, which
    // comes back without dimensions and takes the camera with it.
    for (let channel = 0; channel < layers.length; channel += 1) {
      const before = previous[channel]
      const after = layers[channel]
      if (JSON.stringify(before) === JSON.stringify(after)) continue

      // Nothing here is applied unless the rest of the layer is unchanged: a source or
      // geometry change needs a replacement, and applying half of it would leave
      // Neuroglancer showing one channel's data under another's settings.
      if (!appliesToLiveLayer(before, after)) continue

      if (before.visible !== after.visible) {
        // The layer's own flag, set the way Neuroglancer's layer bar sets it. Doing
        // this through the state would replace the layer.
        managedLayer(props.viewer, channel)?.setVisible?.(
          after.visible === true
        )
      }

      if (
        before.opacity !== after.opacity &&
        typeof after.opacity === "number"
      ) {
        const live = opacityOf(props.viewer, channel)
        if (live) live.value = after.opacity
      }

      if (
        before.volumeRenderingDepthSamples !== after.volumeRenderingDepthSamples
      ) {
        // Its validator throws outside [2, 2**21 - 1] and restoreState swallows that,
        // falling back to Neuroglancer's own default of 64 -- which is why the store
        // snaps this to a known ladder before it ever gets here.
        projectionSamplesOf(props.viewer, channel)?.restoreState(
          after.volumeRenderingDepthSamples
        )
      }

      if (before.volumeRendering !== after.volumeRendering) {
        // Neuroglancer registers and disposes the volume-rendering render layer in
        // reaction to this trackable, so setting it is the whole toggle -- the layer
        // itself, its data source and the camera are untouched. restoreState rather than
        // `.value` because the trackable parses the mode name we already build.
        volumeRenderingModeOf(props.viewer, channel)?.restoreState(
          after.volumeRendering
        )
      }

      const live = shaderControlsOf(props.viewer, channel)
      if (live) live.restoreState(after.shaderControls)
    }
  }, [controls, layerTarget, props.viewer])

  useEffect(() => {
    const position = snapshot.position
    // `snapshot.zoom` is unusable: the hook reads `navigationState.zoomFactor`, which
    // Neuroglancer's state JSON does not have, and `false ?? …` does not fall through
    // because `??` only reacts to null and undefined. The scale is in the raw state.
    const zoom = (snapshot.raw ?? {}).crossSectionScale
    if (!position && typeof zoom !== "number") return
    dispatch(
      cameraMoved(
        position && position.length >= 3
          ? [position[0], position[1], position[2]]
          : null,
        typeof zoom === "number" ? zoom : null
      )
    )
  }, [dispatch, snapshot])

  // The one place a control reaches the viewer's pose. Driven by `pendingPosition`, which
  // only the Z-slice slider sets, so this never fires in reaction to the viewer's own
  // movement -- the snapshot effect above reads that, and reading is all it does.
  //
  // `viewer.state.restoreState` is a PARTIAL restore: it only touches the keys the object
  // carries, so passing `{ position }` moves the camera and leaves `dimensions`, the layers
  // and the scales exactly as they were. The wrapper's `setState` does not -- it rebuilds
  // the coordinate space, which returns without dimensions and collapses the view into a
  // corner, dead to further input. This is the documented way to move a live viewer.
  const { pendingPosition } = state.camera
  useEffect(() => {
    if (!pendingPosition) return
    try {
      props.viewer.state.restoreState({ position: pendingPosition })
    } finally {
      // Cleared whether or not the push took, so a rejected apply cannot wedge the slider
      // with a pending position that is retried on every render.
      dispatch(cameraApplied())
    }
  }, [pendingPosition, props.viewer, dispatch])

  // On load, open the XY cross-section fitted to its pane rather than at a fixed guess, so
  // the slice fills the panel devoted to it. Done here, not in `buildViewerState`, because
  // only the mounted DOM knows the pane's pixel size; through the same partial restore as
  // the scrub, so it moves only the scale. Skipped when the launch URL pins a zoom -- a
  // shared link is entitled to keep the view its author chose -- and run once per dataset.
  useEffect(() => {
    if (!dataset.id || !dataset.dims) return
    if (fittedFor.current === dataset.id) return
    if (state.launch.zoom != null) {
      fittedFor.current = dataset.id
      return
    }
    const scale = fitCrossSectionScale(dataset.dims.size)
    if (scale === null) return // pane not measurable yet; retried on the next render
    fittedFor.current = dataset.id
    try {
      props.viewer.state.restoreState({ crossSectionScale: scale })
      // Recorded as the default so the URL writer leaves zoom out until the user moves off
      // it. restoreState alone would not tell it apart from a zoom the user chose.
      dispatch(viewFitted(scale))
    } catch {
      // A viewer that will not take a partial restore keeps its built-in scale; the slice
      // is merely at a less ideal zoom, which is not worth surfacing.
    }
  }, [dataset.id, dataset.dims, state.launch.zoom, props.viewer, dispatch])

  return null
}

/**
 * The `crossSectionScale` -- voxels per pixel -- at which the whole in-plane slice just
 * fits the XY pane. The default layout is 4panel, so that pane is about half the viewer
 * area each way; a small margin keeps the slice clear of the panel borders rather than
 * clipped by them. Null when the pane cannot be measured yet, so the caller retries.
 */
const PANE_FIT_MARGIN = 0.96

function fitCrossSectionScale(size: { x: number; y: number }): number | null {
  // The viewer area, or the window if it has not been laid out yet -- so a zero measurement
  // does not leave the fit permanently unrun, since the effect will not retry on its own.
  const rect = document.querySelector(".viewer-area")?.getBoundingClientRect()
  const areaWidth = rect && rect.width > 0 ? rect.width : window.innerWidth
  const areaHeight = rect && rect.height > 0 ? rect.height : window.innerHeight
  const paneWidth = (areaWidth / 2) * PANE_FIT_MARGIN
  const paneHeight = (areaHeight / 2) * PANE_FIT_MARGIN
  if (paneWidth <= 0 || paneHeight <= 0) return null
  const scale = Math.max(size.x / paneWidth, size.y / paneHeight)
  return Number.isFinite(scale) && scale > 0 ? scale : null
}

/** The layers inside a viewer state JSON string, or null if there is no reading it. */
function initialLayers(
  viewerState: string | null
): Array<Record<string, unknown>> | null {
  if (!viewerState) return null
  try {
    const { layers } = JSON.parse(viewerState) as { layers?: unknown }
    return Array.isArray(layers)
      ? (layers as Array<Record<string, unknown>>)
      : null
  } catch {
    return null
  }
}

/**
 * One of Neuroglancer's managed layers, or null if it cannot be reached.
 *
 * These go through Neuroglancer's internals rather than the wrapper's API, because the
 * wrapper only offers whole-state restore, and a whole-state restore is what breaks the
 * camera. Defensive at every step: an upgrade that moves any of this returns null, and
 * the change is simply not applied rather than applied destructively.
 *
 * Layer order matches channel order because `buildViewerState` emits them that way.
 */
function managedLayer(
  viewer: NeuroglancerViewerInstance,
  channel: number
): ManagedLayer | null {
  const layers = (
    viewer as { layerManager?: { managedLayers?: ManagedLayer[] } }
  ).layerManager?.managedLayers
  return layers?.[channel] ?? null
}

interface ManagedLayer {
  setVisible?: (visible: boolean) => void
  layer?: {
    shaderControlState?: unknown
    opacity?: { value?: unknown }
    volumeRenderingMode?: { restoreState?: unknown }
    volumeRenderingDepthSamplesTarget?: { restoreState?: unknown }
  } | null
}

/**
 * The live opacity of one channel's layer. Neuroglancer's own control, the one its layer
 * bar and its JSON state use, so setting it cannot disagree with what the user sees in
 * the rendering tab.
 */
function opacityOf(
  viewer: NeuroglancerViewerInstance,
  channel: number
): { value: number } | null {
  const opacity = managedLayer(viewer, channel)?.layer?.opacity
  return typeof opacity?.value === "number"
    ? (opacity as { value: number })
    : null
}

/** How finely the live layer's 3D projection samples the volume. */
function projectionSamplesOf(
  viewer: NeuroglancerViewerInstance,
  channel: number
): { restoreState: (json: unknown) => void } | null {
  const target = managedLayer(viewer, channel)?.layer
    ?.volumeRenderingDepthSamplesTarget
  return typeof target?.restoreState === "function"
    ? (target as { restoreState: (json: unknown) => void })
    : null
}

/** The live 3D-projection mode of one channel's layer. */
function volumeRenderingModeOf(
  viewer: NeuroglancerViewerInstance,
  channel: number
): { restoreState: (json: unknown) => void } | null {
  const mode = managedLayer(viewer, channel)?.layer?.volumeRenderingMode
  return typeof mode?.restoreState === "function"
    ? (mode as { restoreState: (json: unknown) => void })
    : null
}

/**
 * The live shader controls for one channel's layer. `ShaderControlState.restoreState`
 * takes the same `shaderControls` object we already build, resets each control, and
 * applies what it finds -- without touching the layer, its source, or the coordinate
 * space.
 */
function shaderControlsOf(
  viewer: NeuroglancerViewerInstance,
  channel: number
): { restoreState: (json: unknown) => void } | null {
  const state = managedLayer(viewer, channel)?.layer?.shaderControlState as
    { restoreState?: (json: unknown) => void } | undefined
  return typeof state?.restoreState === "function"
    ? (state as { restoreState: (json: unknown) => void })
    : null
}

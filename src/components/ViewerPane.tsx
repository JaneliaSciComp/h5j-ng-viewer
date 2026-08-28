import { useEffect, useRef, useState } from "react"
import type { ReactElement } from "react"
import {
  NeuroglancerViewer,
  useNeuroglancer,
} from "@janelia/react-neuroglancer"
import type { NeuroglancerViewerInstance } from "@janelia/react-neuroglancer"
import { appliesToLiveLayer, buildLayer } from "@/lib/ngstate"
import { cameraMoved } from "@/state/actions"
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
  // Only the snapshot is used now. Nothing pushes whole state any more: every change
  // lands on a live layer, which is what keeps the coordinate space intact.
  const { snapshot } = useNeuroglancer(props.viewer)

  const { controls, dataset } = state
  const layerTarget = layerDataset(state, props.origin)

  // What Neuroglancer currently has, one entry per channel. Compared before pushing, so
  // an unrelated render cannot cause a redundant update -- and so the layers already
  // inside `initialState` are not immediately pushed back on mount.
  const lastPushed = useRef<Array<Record<string, unknown>> | null>(null)

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

  return null
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

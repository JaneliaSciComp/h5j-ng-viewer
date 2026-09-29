// Builds the Neuroglancer viewer state -- handed to <NeuroglancerViewer> as a JSON
// string, which it parses once on mount -- and the generated multi-channel additive
// shader, mirroring the working production state in flyefish-web's
// neuroglancer-base.json.

import type { BitDepth, ChannelControls, Vec3 } from "@/types"
import { maxValue as maxValueForBits } from "@/lib/zarr"
import { ZARR_URL_PREFIX } from "@/lib/paths"
import { DEFAULT_PROJECTION_SAMPLES } from "@/lib/projection"

/**
 * Neuroglancer data-source URL for a dataset served by our service worker.
 * The `|zarr2:` suffix selects the zarr v2 driver explicitly, which skips a
 * round of speculative probing for candidate metadata files. The trailing slash on
 * the directory path matters.
 */
export function zarrSourceUrl(
  origin: string,
  datasetId: string,
  channel: number
): string {
  return `${origin}${ZARR_URL_PREFIX}${datasetId}/c${channel}/|zarr2:`
}

/**
 * The shader for one channel's layer: a color and an invlerp. Layers are blended
 * additively by Neuroglancer, so what used to be a loop over channels inside one shader
 * is now one of these per layer.
 *
 * `normalized()` is load-bearing beyond the obvious. Neuroglancer's generated invlerp
 * assigns its result to an internal `defaultMaxProjectionIntensity`, and that is what
 * maximum-intensity projection ranks samples by when a shader does not call
 * `emitIntensity` itself. Calling it once per fragment is therefore what makes the 3D
 * view work; a shader that computed the value some other way would render a flat slab.
 * The alpha of 1 matters for the same reason: MIP takes the color of the winning
 * sample, so anything less would dim the projection uniformly.
 *
 * Opacity is deliberately NOT here. Neuroglancer wraps every shader with
 * `emit(vec4(rgb, a * uOpacity))`, and under additive blending -- `SRC_ALPHA, ONE` --
 * that alpha is exactly what scales the layer's contribution. A second opacity in the
 * shader would multiply on top of the layer's own, giving the user two sliders that both
 * dim the same channel.
 *
 * The source is the same for every channel and every dataset of a given bit depth --
 * nothing about the current rendering appears in it. That is what lets a recolor be
 * applied to the live layer through its shader controls instead of replacing it, and
 * replacing a layer is what makes Neuroglancer rebuild its coordinate space.
 */
export function buildShader(maxValue: number): string {
  return (
    `#uicontrol vec3 hue color(default="#ffffff")\n` +
    `#uicontrol invlerp normalized(range=[0,${maxValue}])\n` +
    "\n" +
    "void main(){\n" +
    "    emitRGBA(vec4(hue * normalized(), 1));\n" +
    "}"
  )
}

/**
 * The coordinate space and where the camera sits in it -- the fields that Neuroglancer
 * loses when a layer is replaced.
 */
export interface CameraFields {
  dimensions?: unknown
  position?: unknown
  crossSectionScale?: unknown
  projectionScale?: unknown
}

export function cameraFields(state: Record<string, unknown>): CameraFields {
  return {
    dimensions: state.dimensions,
    position: state.position,
    crossSectionScale: state.crossSectionScale,
    projectionScale: state.projectionScale,
  }
}

/**
 * Whether a viewer state came back without its coordinate space.
 *
 * Replacing a layer makes Neuroglancer rebuild that space, and the state it reports
 * afterwards can have no `dimensions` at all. Everything derived from the space is then
 * wrong in a specific, measurable way: `crossSectionScale` and `projectionScale` are
 * expressed in voxels, so without a voxel size they are reinterpreted as meters and come
 * back multiplied by it. Measured on a real load: 2.36 became 1.23e-6 and 1815 became
 * 9.42e-4, against a voxel size of 5.189161e-7 m. The view collapses to a speck in a
 * corner, with no error anywhere.
 *
 * The caller's remedy is to put the space and the camera back as they were. This returns
 * false when Neuroglancer keeps its dimensions, so the repair disappears by itself if a
 * later version stops losing them.
 */
export function lostCoordinateSpace(state: Record<string, unknown>): boolean {
  const dimensions = state.dimensions
  return (
    typeof dimensions !== "object" ||
    dimensions === null ||
    Object.keys(dimensions).length === 0
  )
}

/** The layer fields that can be changed on a live layer, each by its own accessor. */
const LIVE_FIELDS = [
  "shaderControls",
  "visible",
  "opacity",
  "volumeRendering",
  "volumeRenderingDepthSamples",
] as const

/**
 * Whether two layers differ only in ways that can be applied to the layer Neuroglancer
 * already has: its shader controls, its visibility, its opacity, and whether and how
 * finely it projects in 3D.
 *
 * Each has its own accessor -- `shaderControlState.restoreState`, `setVisible`,
 * `opacity.value`, `volumeRenderingMode.restoreState`,
 * `volumeRenderingDepthSamplesTarget.restoreState` -- and none of them touches the data
 * source or the coordinate space.
 * They are excluded from the comparison rather than compared, so that two of them
 * changing at once is still recognized as applicable; comparing them would report
 * "not applicable" and the change would be dropped. Anything else needs the whole layer
 * replaced, which costs a data-source teardown and takes the camera with it.
 */
export function appliesToLiveLayer(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const strip = (layer: Record<string, unknown>) => {
    const rest = { ...layer }
    for (const field of LIVE_FIELDS) delete rest[field]
    return JSON.stringify(rest)
  }
  return strip(a) === strip(b)
}

/** What a layer needs beyond the user's controls: where the data is and how big it is. */
export interface LayerDataset {
  origin: string
  datasetId: string
  /** Layer name shown in Neuroglancer's own layer bar. */
  datasetName: string
  /** micrometers per voxel at level 0 */
  voxelSize: Vec3
  bits: BitDepth
  /** One name per channel, in c-axis order. */
  channelNames: string[]
  /**
   * Per channel: has its data been written yet? A channel that is still converting gets
   * its layer straight away -- it must, because a layer whose `.zattrs` 404s fails to
   * resolve and never retries -- but not its visibility.
   */
  ready: boolean[]
}

/**
 * The complete image layer, derived from the controls.
 *
 * Every push of state into Neuroglancer goes through this one function, whether it is
 * the initial mount or a later update. That is the point: `setState` replaces the whole
 * `layers` array, so anything that rebuilds a layer from defaults instead of from
 * current controls silently discards whatever the user has changed. There is deliberately
 * no way to build a partial layer.
 */
export function buildLayer(
  controls: ChannelControls,
  dataset: LayerDataset,
  channel: number
): Record<string, unknown> {
  const { origin, datasetId, voxelSize, bits, channelNames } = dataset
  const dx = voxelSize.x * 1e-6
  const dy = voxelSize.y * 1e-6
  const dz = voxelSize.z * 1e-6
  const max = maxValueForBits(bits)

  // Contrast comes from the measured data when we have it. The dtype range is a poor
  // default for fluorescence: these volumes are mostly near-zero background with signal
  // in a narrow band, so [0, 4095] maps everything to near-black and the view looks
  // empty. `window` stays at the full dtype range so the slider can be widened.
  const measured = controls.contrast[channel]
  const range = measured && measured[1] > measured[0] ? measured : [0, max]

  const shaderControls: Record<string, unknown> = {
    normalized: { range, window: [0, max] },
    // Always written, because the shader's own default is a placeholder white: the
    // color has to live here for a recolor to be a control change rather than a
    // change to the shader source.
    hue: controls.colors[channel],
  }

  return {
    type: "image",
    name: channelNames[channel],
    source: {
      url: zarrSourceUrl(origin, datasetId, channel),
      transform: {
        outputDimensions: {
          z: [dz, "m"],
          y: [dy, "m"],
          x: [dx, "m"],
        },
      },
    },
    blend: "additive",
    // Always written, and never omitted as "the default": Neuroglancer's own default for
    // an image layer is 0.5, and under additive blending that halves the channel. A
    // layer left to default therefore renders at half the intensity the user asked for.
    opacity: controls.opacity[channel] ?? 1,
    // Maximum-intensity projection, which is what a 3D view of a fluorescence stack
    // means -- the same thing Fiji's 3D projection shows. Without it an image layer
    // contributes nothing at all to the perspective panel except the cross-section
    // planes, so Neuroglancer's single-panel "3d" layout comes up empty: it is the one
    // layout that registers no slice views, and there is no setting that changes that.
    // "max" rather than "on": emission/absorption raycasting reads the alpha this
    // shader emits, and that alpha is 1, which would render the volume as a solid box.
    // Written either way rather than omitted when off, so the two states differ by a
    // value the live-apply path can compare instead of by a missing key.
    volumeRendering: controls.volumeRendering ? "max" : "off",
    // Neuroglancer's own default here is 64, which for a volume this deep selects one of
    // the coarsest pyramid levels -- this value doubles as the volume-rendering
    // renderScaleTarget -- and the projection comes out in visible blocks.
    volumeRenderingDepthSamples:
      controls.projectionSamples ?? DEFAULT_PROJECTION_SAMPLES,
    tab: "rendering",
    shader: buildShader(max),
    shaderControls,
    // The layer's own flag, not a shader control. Neuroglancer does not fetch chunks for
    // a layer that is not visible -- measured, 43 requests against 0 -- which is what
    // keeps a channel that is still converting from being read half-written. A channel
    // the user wants shown therefore still waits for its data to exist, and turns
    // visible by itself the moment it does.
    visible:
      dataset.ready[channel] === true && controls.visible[channel] !== false,
  }
}

export function buildViewerState(opts: {
  controls: ChannelControls
  dataset: LayerDataset
  /** level 0 voxel extent, used to center the initial position */
  size: Vec3
  /** Voxel position to open on; defaults to the center of the volume. */
  position?: [number, number, number]
  /** Cross-section scale in voxels per pixel; defaults to fitting the volume. */
  crossSectionScale?: number
}): Record<string, unknown> {
  const { controls, dataset, size } = opts
  const { voxelSize } = dataset

  // Neuroglancer works in SI units; the H5J/zarr pipeline works in micrometers.
  const dx = voxelSize.x * 1e-6
  const dy = voxelSize.y * 1e-6
  const dz = voxelSize.z * 1e-6

  // Scales are in VOXELS, not meters. `dimensions` declares meters *per voxel*, so the
  // coordinate space is voxel-indexed -- which is why `position` is a voxel index.
  // Computing these from the physical extent instead yields values around 1e-3 and
  // zooms the 3D view in by a factor of a million, leaving it blank.
  const longestAxis = Math.max(size.x, size.y, size.z)
  const projectionScale = longestAxis * 1.5

  // Voxels per pixel. A rough guess only: this is built before the viewer mounts, so the
  // pane's pixel size is unknown here. `ViewerPane` refines it to the actual XY pane on
  // load so the slice fills its panel. A launch parameter wins over both, so a shared link
  // opens at the zoom its author chose.
  const crossSectionScale =
    opts.crossSectionScale ?? Math.max(1, Math.max(size.x, size.y) / 512)

  const position = opts.position ?? [size.x / 2, size.y / 2, size.z / 2]

  return {
    dimensions: {
      x: [dx, "m"],
      y: [dy, "m"],
      z: [dz, "m"],
    },
    position,
    // One layer per channel, blended additively by Neuroglancer -- rather than one layer
    // over one array with a channel axis, which would have to be complete before any of
    // it could be read. This is what lets the viewer mount on the first converted channel
    // and light up the rest as they land.
    layers: dataset.channelNames.map((_, channel) =>
      buildLayer(controls, dataset, channel)
    ),
    layout: "4panel",
    crossSectionScale,
    projectionScale,
  }
}

// Builds the Neuroglancer viewer state (F13: handed to <NeuroglancerViewer> as a JSON
// string) and the generated multi-channel additive shader, mirroring the working
// production state in ../flyefish-web/src/config/neuroglancer-base.json.

import type { BitDepth, Vec3 } from "@/types"
import { maxValue as maxValueForBits } from "@/lib/zarr"
import { ZARR_URL_PREFIX } from "@/lib/paths"

/**
 * Neuroglancer data-source URL for a dataset served by our service worker.
 * The `|zarr2:` suffix selects the zarr v2 driver explicitly (F4), which skips a
 * round of speculative probing for candidate metadata files. The trailing slash on
 * the directory path matters.
 */
export function zarrSourceUrl(origin: string, datasetId: string): string {
  return `${origin}${ZARR_URL_PREFIX}${datasetId}/|zarr2:`
}

/**
 * GLSL shader blending N channels additively, one #uicontrol colour and one
 * #uicontrol invlerp per channel, each gated by a checkbox. Controls are indexed
 * (show_channel_0, hue0, normalized0, ...) rather than named after the channel,
 * because channel names may contain characters that are not valid GLSL identifiers.
 */
export function buildShader(
  channelNames: string[],
  channelColors: string[],
  maxValue: number
): string {
  const n = channelNames.length
  const controls: string[] = []
  const accumulations: string[] = []
  for (let i = 0; i < n; i++) {
    controls.push(
      `#uicontrol bool show_channel_${i} checkbox(default=true)\n` +
        `#uicontrol vec3 hue${i} color(default="${channelColors[i]}")\n` +
        `#uicontrol invlerp normalized${i}(range=[0,${maxValue}], channel=[${i}])`
    )
    accumulations.push(
      `    if (show_channel_${i})\n` +
        `        blended_color += hue${i} * normalized${i}();`
    )
  }
  return (
    controls.join("\n\n") +
    "\n\n" +
    "void main(){\n" +
    "    vec3 blended_color = vec3(0,0,0);\n" +
    accumulations.join("\n") +
    "\n" +
    "    emitRGBA(vec4(blended_color, 1));\n" +
    "}"
  )
}

export function buildViewerState(opts: {
  origin: string
  datasetId: string
  datasetName: string
  channelNames: string[]
  channelColors: string[]
  /** micrometers per voxel at level 0 */
  voxelSize: Vec3
  /** level 0 voxel extent, used to centre the initial position */
  size: Vec3
  bits: BitDepth
  /** Measured [low, high] display range per channel; falls back to the dtype range. */
  channelRanges?: Array<[number, number]>
}): Record<string, unknown> {
  const {
    origin,
    datasetId,
    datasetName,
    channelNames,
    channelColors,
    voxelSize,
    size,
    bits,
  } = opts

  // Neuroglancer works in SI units; the H5J/zarr pipeline works in micrometers.
  const dx = voxelSize.x * 1e-6
  const dy = voxelSize.y * 1e-6
  const dz = voxelSize.z * 1e-6

  // F11: the H5J loader's 16-bit path returns unscaled 12-bit values (0-4095), not
  // full-range 16-bit (0-65535). Using 65535 here would render everything near-black.
  const max = maxValueForBits(bits)

  // Contrast comes from the measured data when we have it. The dtype range is a poor
  // default for fluorescence: these volumes are mostly near-zero background with
  // signal in a narrow band, so [0, 4095] maps everything to near-black and the view
  // looks empty. `window` stays at the full dtype range so the slider can be widened.
  const shaderControls: Record<string, unknown> = {}
  for (let i = 0; i < channelNames.length; i++) {
    const measured = opts.channelRanges?.[i]
    const range = measured && measured[1] > measured[0] ? measured : [0, max]
    shaderControls[`normalized${i}`] = { range, window: [0, max] }
  }

  // Scales are in VOXELS, not metres. `dimensions` declares metres *per voxel*, so the
  // coordinate space is voxel-indexed -- which is why `position` is a voxel index.
  // Computing these from the physical extent instead yields values around 1e-3 and
  // zooms the 3D view in by a factor of a million, leaving it blank.
  const longestAxis = Math.max(size.x, size.y, size.z)
  const projectionScale = longestAxis * 1.5

  // Voxels per pixel, chosen so the largest in-plane slice roughly fits a quadrant of
  // a 4panel layout rather than opening zoomed into one corner.
  const crossSectionScale = Math.max(1, Math.max(size.x, size.y) / 512)

  return {
    dimensions: {
      x: [dx, "m"],
      y: [dy, "m"],
      z: [dz, "m"],
    },
    position: [size.x / 2, size.y / 2, size.z / 2],
    layers: [
      {
        type: "image",
        name: datasetName,
        source: {
          url: zarrSourceUrl(origin, datasetId),
          transform: {
            outputDimensions: {
              "c^": [1, ""],
              z: [dz, "m"],
              y: [dy, "m"],
              x: [dx, "m"],
            },
          },
        },
        channelDimensions: { "c^": [1, ""] },
        blend: "additive",
        tab: "rendering",
        shader: buildShader(channelNames, channelColors, max),
        shaderControls,
      },
    ],
    layout: "4panel",
    crossSectionScale,
    projectionScale,
  }
}

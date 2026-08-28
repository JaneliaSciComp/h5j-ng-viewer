import { describe, expect, it } from "vitest"
import {
  buildLayer,
  buildShader,
  buildViewerState,
  cameraFields,
  appliesToLiveLayer,
  lostCoordinateSpace,
  zarrSourceUrl,
} from "@/lib/ngstate"
import type { LayerDataset } from "@/lib/ngstate"
import {
  PROJECTION_SAMPLE_LIMITS,
  PROJECTION_SAMPLE_STEPS,
} from "@/lib/projection"
import type { ChannelControls } from "@/types"

/** Controls for `n` channels: all visible, fully opaque, nothing measured yet. */
function controlsFor(
  n: number,
  overrides: Partial<ChannelControls> = {}
): ChannelControls {
  const palette = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"]
  return {
    visible: Array.from({ length: n }, () => true),
    colors: Array.from({ length: n }, (_, i) => palette[i % palette.length]),
    opacity: Array.from({ length: n }, () => 1),
    contrast: Array.from({ length: n }, () => undefined),
    volumeRendering: false,
    projectionSamples: 512,
    ...overrides,
  }
}

/** A dataset whose channels have all finished converting, unless told otherwise. */
function datasetFor(
  n: number,
  overrides: Partial<LayerDataset> = {}
): LayerDataset {
  return {
    origin: "http://localhost:3000",
    datasetId: "ds1",
    datasetName: "my dataset",
    voxelSize: { x: 0.44, y: 0.44, z: 0.44 },
    bits: 16 as const,
    channelNames: Array.from({ length: n }, (_, i) => `ch${i}`),
    ready: Array.from({ length: n }, () => true),
    ...overrides,
  }
}

const SIZE = { x: 256, y: 128, z: 64 }

/** One channel's layer: each channel has its own, in channel order. */
function layerOf(state: Record<string, unknown>, channel: number) {
  return (state.layers as Array<Record<string, unknown>>)[channel]
}

function shaderControlsOf(state: Record<string, unknown>, channel: number) {
  return layerOf(state, channel).shaderControls as Record<
    string,
    { range: number[]; window: number[] } & unknown
  >
}

describe("zarrSourceUrl", () => {
  it("names the channel's own array, not the dataset", () => {
    // Each channel is a separate zarr array so that it resolves and renders the moment
    // it finishes converting, without waiting for its siblings.
    expect(zarrSourceUrl("http://localhost:3000", "abc123", 2)).toBe(
      "http://localhost:3000/zarr/abc123/c2/|zarr2:"
    )
  })

  it("gives different channels different sources", () => {
    const origin = "http://localhost:3000"
    expect(zarrSourceUrl(origin, "abc123", 0)).not.toBe(
      zarrSourceUrl(origin, "abc123", 1)
    )
  })
})

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("buildShader", () => {
  it("emits one uicontrol set, with no channel index anywhere", () => {
    // One layer per channel now, so the shader describes a single channel and is the
    // same string for every layer of a given bit depth.
    const shader = buildShader(4095)

    // The color default is a placeholder: the real color lives in shaderControls, so
    // that a recolor never changes the shader source.
    expect(shader).toContain(`hue color(default="#ffffff")`)
    expect(shader).toContain("normalized(range=[0,4095])")
    expect(shader).not.toMatch(/hue\d/)
    expect(shader).not.toMatch(/normalized\d/)
    expect(shader).not.toContain("show_channel")
    expect(shader).not.toContain("channel=[")

    // Every declared control must actually be referenced in main(), or it appears in
    // Neuroglancer's rendering tab and does nothing.
    for (const control of ["hue", "normalized"]) {
      expect(countOccurrences(shader, control)).toBeGreaterThanOrEqual(2)
    }
    expect(countOccurrences(shader, "void main()")).toBe(1)
    expect(countOccurrences(shader, "emitRGBA")).toBe(1)
  })

  it("multiplies the channel by its color", () => {
    expect(buildShader(4095)).toContain("hue * normalized()")
  })

  it("declares no opacity of its own", () => {
    // Neuroglancer wraps every shader with `emit(vec4(rgb, a * uOpacity))`, and additive
    // blending is `SRC_ALPHA, ONE`, so the layer's own opacity already scales the
    // channel. A second one in the shader would be a second slider dimming the same
    // thing, and the two would multiply.
    expect(buildShader(4095)).not.toContain("opacity")
  })

  it("uses range=[0,255] for the 8-bit max value", () => {
    const shader = buildShader(255)
    expect(shader).toContain("range=[0,255]")
    expect(shader).not.toContain("range=[0,4095]")
  })

  it("uses range=[0,4095] for the 16-bit max value", () => {
    expect(buildShader(4095)).toContain("range=[0,4095]")
  })

  it("does not emit a trailing comma or dangling operator", () => {
    const shader = buildShader(4095)
    expect(shader).not.toMatch(/,\s*[)}]/)
    expect(shader).not.toMatch(/\+\s*$/m)
  })

  it("is identical for every channel of a dataset", () => {
    const dataset = datasetFor(2)
    const a = buildLayer(controlsFor(2), dataset, 0)
    const b = buildLayer(controlsFor(2), dataset, 1)
    expect(a.shader).toBe(b.shader)
  })
})

describe("no unscaled 16-bit range anywhere", () => {
  // The H5J loader's 16-bit path returns unscaled 12-bit values, so a [0,65535]
  // invlerp renders everything near-black.
  it("65535 never appears in a 16-bit shader", () => {
    expect(buildShader(4095)).not.toContain("65535")
  })

  it("65535 never appears in a 16-bit viewer state, even as a JSON string", () => {
    const state = buildViewerState({
      controls: controlsFor(2),
      dataset: datasetFor(2),
      size: SIZE,
    })
    expect(JSON.stringify(state)).not.toContain("65535")
  })
})

describe("buildLayer is the only way a layer is made", () => {
  it("produces the same layers buildViewerState embeds", () => {
    // The guarantee this pins: a later update and the initial mount cannot drift apart,
    // because there is one function and both callers use it.
    const controls = controlsFor(2, { visible: [true, false] })
    const dataset = datasetFor(2)
    const state = buildViewerState({ controls, dataset, size: SIZE })
    for (const channel of [0, 1]) {
      expect(buildLayer(controls, dataset, channel)).toEqual(
        layerOf(state, channel)
      )
    }
  })

  it("carries that channel's source, its name and additive blend", () => {
    const layer = buildLayer(controlsFor(2), datasetFor(2), 1)
    expect(layer.name).toBe("ch1")
    expect(layer.blend).toBe("additive")
    const source = layer.source as {
      transform: { outputDimensions: Record<string, unknown> }
      url: string
    }
    expect(source.url).toBe(zarrSourceUrl("http://localhost:3000", "ds1", 1))
    // Three spatial axes and nothing else: the channel axis is gone, so there is no
    // `channelDimensions` and no chunks[0] === shape[0] constraint to satisfy.
    expect(Object.keys(source.transform.outputDimensions)).toEqual([
      "z",
      "y",
      "x",
    ])
    expect(layer.channelDimensions).toBeUndefined()
  })
})

describe("the 3D projection follows the control, and is a maximum-intensity one", () => {
  // Neuroglancer's single-panel "3d" layout registers no slice views and hard-codes
  // showSliceViews to false, so an image layer that renders nothing of its own leaves
  // that panel blank. Volume rendering is what fills it, and MIP is the modality a
  // fluorescence stack calls for.
  const layerWith = (volumeRendering: boolean) =>
    buildLayer(controlsFor(1, { volumeRendering }), datasetFor(1), 0)

  it("asks for max, not plain emission/absorption", () => {
    // "on" raycasts using the alpha the shader emits. This shader emits 1, which would
    // make the first sample along every ray opaque and render the volume as a box.
    expect(layerWith(true).volumeRendering).toBe("max")
  })

  it("says off explicitly rather than leaving the key out", () => {
    // The two states have to differ by a value: the live-apply path compares this field
    // between the layer Neuroglancer has and the one just built, and a missing key on
    // one side would make the toggle depend on which way it was flipped.
    expect(layerWith(false).volumeRendering).toBe("off")
  })

  it("is off unless the control says otherwise", () => {
    const state = buildViewerState({
      controls: controlsFor(3),
      dataset: datasetFor(3),
      size: SIZE,
    })
    for (const channel of [0, 1, 2]) {
      expect(layerOf(state, channel).volumeRendering).toBe("off")
    }
  })

  it("turns on for every channel at once, since it is one view-wide choice", () => {
    const state = buildViewerState({
      controls: controlsFor(3, { volumeRendering: true }),
      dataset: datasetFor(3),
      size: SIZE,
    })
    for (const channel of [0, 1, 2]) {
      expect(layerOf(state, channel).volumeRendering).toBe("max")
    }
  })

  it("is applicable to a live layer, so the toggle keeps the camera", () => {
    expect(appliesToLiveLayer(layerWith(false), layerWith(true))).toBe(true)
  })

  it("asks for far more ray samples than Neuroglancer's default 64", () => {
    // This value doubles as the volume-rendering renderScaleTarget, so it picks the
    // pyramid level the projection reads. At 64 a volume this deep resolves to one of
    // the coarsest levels and the projection comes out in visible blocks.
    const samples = layerWith(true).volumeRenderingDepthSamples
    expect(typeof samples).toBe("number")
    expect(samples as number).toBeGreaterThanOrEqual(256)
  })

  it("carries the requested detail through to the layer", () => {
    const layer = buildLayer(
      controlsFor(1, { volumeRendering: true, projectionSamples: 4096 }),
      datasetFor(1),
      0
    )
    expect(layer.volumeRenderingDepthSamples).toBe(4096)
  })

  it("stays inside Neuroglancer's range for every step of the ladder", () => {
    // Outside it, the trackable's validator throws and restoreState swallows the throw,
    // reverting to Neuroglancer's default of 64 -- the blockiest setting, reached
    // silently, which is the worst possible failure for a detail control.
    for (const samples of PROJECTION_SAMPLE_STEPS) {
      expect(samples).toBeGreaterThanOrEqual(PROJECTION_SAMPLE_LIMITS.min)
      expect(samples).toBeLessThanOrEqual(PROJECTION_SAMPLE_LIMITS.max)
    }
  })

  it("changing the detail is applicable to a live layer", () => {
    const coarse = buildLayer(
      controlsFor(1, { volumeRendering: true, projectionSamples: 512 }),
      datasetFor(1),
      0
    )
    const fine = buildLayer(
      controlsFor(1, { volumeRendering: true, projectionSamples: 8192 }),
      datasetFor(1),
      0
    )
    expect(appliesToLiveLayer(coarse, fine)).toBe(true)
  })

  it("keeps the shader's emitted alpha at 1, which MIP relies on", () => {
    // MIP takes the color of the brightest sample; a smaller alpha would dim the whole
    // projection uniformly for no reason the user asked for.
    expect(layerWith(true).shader).toContain(
      "emitRGBA(vec4(hue * normalized(), 1))"
    )
  })

  it("calls normalized() in main(), which is what sets the projected intensity", () => {
    // Neuroglancer's generated invlerp assigns to an internal
    // defaultMaxProjectionIntensity, and MIP ranks samples by that when the shader does
    // not call emitIntensity. Compute the value another way and the projection flattens.
    const shader = layerWith(true).shader as string
    expect(shader.slice(shader.indexOf("void main()"))).toContain(
      "normalized()"
    )
  })
})

describe("buildViewerState", () => {
  const state = () =>
    buildViewerState({
      controls: controlsFor(2),
      dataset: datasetFor(2),
      size: SIZE,
    })

  it("emits one layer per channel, in channel order", () => {
    const layers = state().layers as Array<Record<string, unknown>>
    expect(layers).toHaveLength(2)
    expect(layers.map((layer) => layer.name)).toEqual(["ch0", "ch1"])
  })

  it("converts micrometers to meters (0.44 um -> 4.4e-7 m)", () => {
    const dims = state().dimensions as Record<string, [number, string]>
    expect(dims.x[0]).toBeCloseTo(4.4e-7, 12)
    expect(dims.z[0]).toBeCloseTo(4.4e-7, 12)
    expect(dims.x[1]).toBe("m")
  })

  it("uses layout 4panel", () => {
    expect(state().layout).toBe("4panel")
  })

  it("positions the camera at the volume center", () => {
    expect(state().position).toEqual([128, 64, 32])
  })

  it("survives a JSON round-trip unchanged, since it is passed as a string", () => {
    const built = state()
    expect(JSON.parse(JSON.stringify(built))).toEqual(built)
  })
})

describe("scales are expressed in voxels, not meters", () => {
  // The regression this pins: `dimensions` declares meters *per voxel*, so the
  // coordinate space is voxel-indexed and `position` is a voxel index. Deriving
  // projectionScale from the physical extent instead produced 9.4e-4 for a real
  // volume, zooming the 3D view in by roughly a million times and leaving it blank
  // with no error.
  const size = { x: 1210, y: 566, z: 174 }
  const state = buildViewerState({
    controls: controlsFor(1),
    dataset: datasetFor(1, {
      voxelSize: { x: 0.5189161, y: 0.5189161, z: 1 },
    }),
    size,
  }) as { projectionScale: number; crossSectionScale: number }

  it("scales projectionScale with the longest axis in voxels", () => {
    expect(state.projectionScale).toBeCloseTo(1210 * 1.5, 6)
  })

  it("does not express projectionScale in meters", () => {
    // The physical extent is 1210 * 0.5189161e-6 m ~= 6.3e-4, so anything below 1
    // here means the meters bug is back.
    expect(state.projectionScale).toBeGreaterThan(1)
  })

  it("keeps crossSectionScale a sane voxels-per-pixel figure", () => {
    expect(state.crossSectionScale).toBeGreaterThanOrEqual(1)
    expect(state.crossSectionScale).toBeLessThan(size.x)
  })
})

describe("measured contrast overrides the dtype range", () => {
  it("uses the measured range and keeps the full dtype window", () => {
    const state = buildViewerState({
      controls: controlsFor(2, { contrast: [[12, 830], undefined] }),
      dataset: datasetFor(2),
      size: SIZE,
    })
    expect(shaderControlsOf(state, 0).normalized.range).toEqual([12, 830])
    // The window stays wide so the slider can be opened up past the measurement.
    expect(shaderControlsOf(state, 0).normalized.window).toEqual([0, 4095])
    // Channel 1 had no measurement yet, so it must fall back rather than invent one.
    expect(shaderControlsOf(state, 1).normalized.range).toEqual([0, 4095])
  })

  it("ignores a degenerate measured range", () => {
    // A zero-width invlerp range makes Neuroglancer render nothing at all, which is
    // worse than a badly-scaled but non-empty default.
    const state = buildViewerState({
      controls: controlsFor(1, { contrast: [[500, 500]] }),
      dataset: datasetFor(1),
      size: SIZE,
    })
    expect(shaderControlsOf(state, 0).normalized.range).toEqual([0, 4095])
  })
})

describe("launch overrides", () => {
  const size = { x: 1210, y: 566, z: 174 }
  const opts = { controls: controlsFor(1), dataset: datasetFor(1), size }

  it("centers the volume and fits the view by default", () => {
    const state = buildViewerState(opts)
    expect(state.position).toEqual([605, 283, 87])
    expect(state.crossSectionScale).toBeCloseTo(1210 / 512)
  })

  it("opens where a shared link says instead", () => {
    const state = buildViewerState({
      ...opts,
      position: [10, 20, 30],
      crossSectionScale: 1,
    })
    expect(state.position).toEqual([10, 20, 30])
    expect(state.crossSectionScale).toBe(1)
  })
})

describe("a channel is not visible until its data exists", () => {
  // This is what makes progressive display safe. Neuroglancer does not fetch chunks for
  // an invisible layer, so a channel still being written is never read half-finished --
  // and every channel's layer can be declared up front, which it must be, since a layer
  // whose .zattrs 404s fails to resolve and never retries.
  const build = (ready: boolean[], visible: boolean[]) =>
    buildViewerState({
      controls: controlsFor(3, { visible }),
      dataset: datasetFor(3, { ready }),
      size: SIZE,
    })

  it("keeps a wanted-but-unconverted channel dark", () => {
    const state = build([true, false, false], [true, true, true])
    expect(layerOf(state, 0).visible).toBe(true)
    expect(layerOf(state, 1).visible).toBe(false)
    expect(layerOf(state, 2).visible).toBe(false)
  })

  it("still declares a layer for every channel, converted or not", () => {
    const layers = build([true, false, false], [true, true, true])
      .layers as Array<Record<string, unknown>>
    expect(layers).toHaveLength(3)
    expect(layers.map((layer) => layer.name)).toEqual(["ch0", "ch1", "ch2"])
  })

  it("does not show a converted channel the user has hidden", () => {
    const state = build([true, true, true], [true, false, true])
    expect(layerOf(state, 1).visible).toBe(false)
  })

  it("turns a channel visible on its own the moment it lands", () => {
    // Nothing else changes: the layer that was already mounted just flips its flag, so
    // the viewer never has to be rebuilt as channels arrive.
    const before = layerOf(build([true, false, true], [true, true, true]), 1)
    const after = layerOf(build([true, true, true], [true, true, true]), 1)
    expect(before.visible).toBe(false)
    expect(after.visible).toBe(true)
    expect(appliesToLiveLayer(before, after)).toBe(true)
  })
})

describe("visibility is the layer's own flag", () => {
  // Not a shader control: Neuroglancer does not fetch chunks for a layer that is not
  // visible -- measured, 43 requests against 0 -- which is what keeps a channel that is
  // still converting from being fetched half-written. A shader that discarded the
  // fragment would fetch it anyway.
  const state = buildViewerState({
    controls: controlsFor(3, { visible: [true, false, true] }),
    dataset: datasetFor(3),
    size: SIZE,
  })

  it("marks exactly the channels the controls hide", () => {
    expect(layerOf(state, 0).visible).toBe(true)
    expect(layerOf(state, 1).visible).toBe(false)
    expect(layerOf(state, 2).visible).toBe(true)
  })

  it("keeps visibility out of the shader controls entirely", () => {
    for (const channel of [0, 1, 2]) {
      const keys = Object.keys(shaderControlsOf(state, channel))
      expect(keys.some((key) => key.includes("show_channel"))).toBe(false)
      expect(keys.some((key) => key.includes("visible"))).toBe(false)
    }
  })
})

describe("color is a shader control, opacity is the layer's own", () => {
  const build = (overrides: Partial<ChannelControls>) =>
    buildViewerState({
      controls: controlsFor(3, overrides),
      dataset: datasetFor(3),
      size: SIZE,
    })

  it("writes the color always, since the shader's own default is a placeholder", () => {
    const state = build({ colors: ["#111111", "#222222", "#333333"] })
    expect(shaderControlsOf(state, 2).hue).toBe("#333333")
    expect(shaderControlsOf(state, 0).hue).toBe("#111111")
  })

  it("writes every opacity, including full", () => {
    // Never omitted as "the default": Neuroglancer's own default for an image layer is
    // 0.5, so a layer left to default renders at half the intensity asked for -- and
    // under additive blending that is a visible dimming of the whole channel.
    const state = build({ opacity: [1, 0.4, 0] })
    expect(layerOf(state, 0).opacity).toBe(1)
    expect(layerOf(state, 1).opacity).toBe(0.4)
    // Zero is a real value, not an absence: a channel faded fully out must stay that
    // way across a reload.
    expect(layerOf(state, 2).opacity).toBe(0)
  })

  it("defaults a channel with no opacity set to full, not to Neuroglancer's half", () => {
    const state = buildViewerState({
      controls: { ...controlsFor(1), opacity: [] },
      dataset: datasetFor(1),
      size: SIZE,
    })
    expect(layerOf(state, 0).opacity).toBe(1)
  })

  it("keeps opacity out of the shader controls", () => {
    const state = build({ opacity: [1, 0.4, 0] })
    for (const channel of [0, 1, 2]) {
      expect(shaderControlsOf(state, channel).opacity).toBeUndefined()
    }
  })

  it("keeps the shader source free of the current colors", () => {
    // This is what makes a recolor a control change rather than a layer change, and a
    // layer change is what makes Neuroglancer rebuild its coordinate space.
    const dataset = datasetFor(1)
    const a = buildLayer(controlsFor(1, { colors: ["#111111"] }), dataset, 0)
    const b = buildLayer(controlsFor(1, { colors: ["#333333"] }), dataset, 0)
    expect(a.shader).toBe(b.shader)
    expect(appliesToLiveLayer(a, b)).toBe(true)
  })
})

describe("repairing the coordinate space after a layer push", () => {
  // Measured on a real load: replacing a layer made Neuroglancer report a state with no
  // `dimensions` at all, and both scales came back multiplied by the voxel size in
  // meters — 2.36328125 became 1.226e-6 against a voxel size of 5.189161e-7 m. The view
  // collapsed to a speck in the corner with no error anywhere.
  const healthy = {
    dimensions: { x: [5.189161e-7, "m"], y: [5.189161e-7, "m"] },
    position: [605, 283, 87],
    crossSectionScale: 2.36328125,
    projectionScale: 1815,
    layers: [{ name: "keep me" }],
  }

  it("recognizes a state that kept its coordinate space", () => {
    expect(lostCoordinateSpace(healthy)).toBe(false)
  })

  it("recognizes one that lost it", () => {
    expect(lostCoordinateSpace({ position: [605, 283, 87] })).toBe(true)
    expect(lostCoordinateSpace({ dimensions: {} })).toBe(true)
    expect(lostCoordinateSpace({ dimensions: null })).toBe(true)
  })

  it("carries exactly the fields needed to put the camera back", () => {
    // Not the layers: those are what the push just changed, and restoring the old ones
    // would undo it.
    expect(cameraFields(healthy)).toEqual({
      dimensions: healthy.dimensions,
      position: healthy.position,
      crossSectionScale: healthy.crossSectionScale,
      projectionScale: healthy.projectionScale,
    })
  })

  it("restores over a damaged state without touching its layers", () => {
    const damaged = {
      position: [605, 283, 87],
      crossSectionScale: 1.226344689453125e-6,
      projectionScale: 0.0009418327214999999,
      layers: [{ name: "the newly pushed layer" }],
    }
    const repaired = { ...damaged, ...cameraFields(healthy) }
    expect(repaired.dimensions).toEqual(healthy.dimensions)
    expect(repaired.crossSectionScale).toBe(2.36328125)
    expect(repaired.layers).toEqual(damaged.layers)
  })
})

describe("appliesToLiveLayer", () => {
  const dataset = datasetFor(2, {
    datasetName: "d",
    voxelSize: { x: 1, y: 1, z: 1 },
  })

  it("is true for every change the bar can make", () => {
    // Color, opacity, a late-arriving measurement and visibility all have to be
    // applicable to the live layer: replacing it re-resolves the data source and loses
    // the camera. Visibility and opacity are excluded from the comparison rather than
    // compared, because each is applied through its own accessor -- so a color change
    // arriving alongside a visibility change is still recognized here.
    const base = buildLayer(controlsFor(2), dataset, 0)
    for (const change of [
      { visible: [false, true] },
      { colors: ["#111111", "#222222"] },
      { opacity: [0.3, 1] },
      { contrast: [[12, 830] as [number, number], undefined] },
      { visible: [false, true], colors: ["#111111", "#222222"] },
      { visible: [false, true], opacity: [0.2, 1] },
    ]) {
      expect(
        appliesToLiveLayer(base, buildLayer(controlsFor(2, change), dataset, 0))
      ).toBe(true)
    }
  })

  it("is false when the data itself changed", () => {
    const base = buildLayer(controlsFor(2), dataset, 0)
    const elsewhere = buildLayer(
      controlsFor(2),
      { ...dataset, datasetId: "ds2" },
      0
    )
    expect(appliesToLiveLayer(base, elsewhere)).toBe(false)
  })

  it("is false across channels, since each has its own source", () => {
    const first = buildLayer(controlsFor(2), dataset, 0)
    const second = buildLayer(controlsFor(2), dataset, 1)
    expect(appliesToLiveLayer(first, second)).toBe(false)
  })
})

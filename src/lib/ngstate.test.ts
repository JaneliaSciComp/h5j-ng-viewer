import { describe, expect, it } from "vitest"
import { buildShader, buildViewerState, zarrSourceUrl } from "@/lib/ngstate"

describe("zarrSourceUrl", () => {
  it("builds the F4 zarr2-suffixed URL with a trailing slash before the suffix", () => {
    expect(zarrSourceUrl("http://localhost:3000", "abc123")).toBe(
      "http://localhost:3000/zarr/abc123/|zarr2:"
    )
  })
})

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe("buildShader", () => {
  it.each([1, 2, 4])(
    "emits one uicontrol trio per channel, all referenced in main(), for N=%i",
    (n) => {
      const names = Array.from({ length: n }, (_, i) => `ch${i}`)
      const colors = Array.from(
        { length: n },
        (_, i) => `#${(i + 1).toString(16).padStart(6, "0")}`
      )
      const shader = buildShader(names, colors, 4095)

      for (let i = 0; i < n; i++) {
        expect(shader).toContain(`show_channel_${i} checkbox(default=true)`)
        expect(shader).toContain(`hue${i} color(default="${colors[i]}")`)
        expect(shader).toContain(
          `normalized${i}(range=[0,4095], channel=[${i}])`
        )
        // Every declared control must actually be referenced in main().
        expect(shader).toContain(`show_channel_${i}`)
        expect(countOccurrences(shader, `hue${i}`)).toBeGreaterThanOrEqual(2)
        expect(
          countOccurrences(shader, `normalized${i}`)
        ).toBeGreaterThanOrEqual(2)
      }

      expect(countOccurrences(shader, "void main()")).toBe(1)
      expect(countOccurrences(shader, "emitRGBA")).toBe(1)
    }
  )

  it("uses range=[0,255] for the 8-bit max value", () => {
    const shader = buildShader(["a"], ["#ff0000"], 255)
    expect(shader).toContain("range=[0,255]")
    expect(shader).not.toContain("range=[0,4095]")
  })

  it("uses range=[0,4095] for the 16-bit max value", () => {
    const shader = buildShader(["a"], ["#ff0000"], 4095)
    expect(shader).toContain("range=[0,4095]")
  })

  it("does not emit a trailing comma or dangling operator (single valid main body)", () => {
    for (const n of [1, 2, 4]) {
      const names = Array.from({ length: n }, (_, i) => `ch${i}`)
      const colors = Array.from({ length: n }, () => "#ffffff")
      const shader = buildShader(names, colors, 4095)
      expect(shader).not.toMatch(/,\s*[)}]/)
      expect(shader).not.toMatch(/\+\s*$/m)
    }
  })
})

describe("F11 regression: no unscaled 16-bit range anywhere", () => {
  it("65535 never appears in a 16-bit shader", () => {
    const shader = buildShader(["a", "b"], ["#ff0000", "#00ff00"], 4095)
    expect(shader).not.toContain("65535")
  })

  it("65535 never appears in a 16-bit viewer state, even as a JSON string", () => {
    const state = buildViewerState({
      origin: "http://localhost:3000",
      datasetId: "ds1",
      datasetName: "dataset",
      channelNames: ["a", "b"],
      channelColors: ["#ff0000", "#00ff00"],
      voxelSize: { x: 0.44, y: 0.44, z: 0.44 },
      size: { x: 256, y: 128, z: 64 },
      bits: 16,
    })
    expect(JSON.stringify(state)).not.toContain("65535")
  })
})

describe("buildViewerState", () => {
  const baseOpts = {
    origin: "http://localhost:3000",
    datasetId: "ds1",
    datasetName: "my dataset",
    channelNames: ["red", "green"],
    channelColors: ["#ff0000", "#00ff00"],
    voxelSize: { x: 0.44, y: 0.44, z: 0.44 },
    size: { x: 256, y: 128, z: 64 },
    bits: 16 as const,
  }

  it("converts micrometers to metres (0.44 um -> 4.4e-7 m)", () => {
    const state = buildViewerState(baseOpts)
    const dims = state.dimensions as Record<string, [number, string]>
    expect(dims.x[0]).toBeCloseTo(4.4e-7, 12)
    expect(dims.y[0]).toBeCloseTo(4.4e-7, 12)
    expect(dims.z[0]).toBeCloseTo(4.4e-7, 12)
    expect(dims.x[1]).toBe("m")
  })

  it("includes c^ in both channelDimensions and the source transform", () => {
    const state = buildViewerState(baseOpts)
    const layers = state.layers as Array<Record<string, unknown>>
    expect(layers).toHaveLength(1)
    const layer = layers[0]
    expect(layer.channelDimensions).toEqual({ "c^": [1, ""] })
    const source = layer.source as {
      transform: { outputDimensions: Record<string, unknown> }
    }
    expect(source.transform.outputDimensions["c^"]).toEqual([1, ""])
  })

  it("uses layout 4panel", () => {
    const state = buildViewerState(baseOpts)
    expect(state.layout).toBe("4panel")
  })

  it("positions the camera at the volume centre", () => {
    const state = buildViewerState(baseOpts)
    expect(state.position).toEqual([128, 64, 32])
  })

  it("the layer source url matches zarrSourceUrl", () => {
    const state = buildViewerState(baseOpts)
    const layers = state.layers as Array<{ source: { url: string } }>
    expect(layers[0].source.url).toBe(
      zarrSourceUrl(baseOpts.origin, baseOpts.datasetId)
    )
  })

  it("survives a JSON round-trip unchanged (F13: state is passed as a JSON string)", () => {
    const state = buildViewerState(baseOpts)
    const roundTripped = JSON.parse(JSON.stringify(state))
    expect(roundTripped).toEqual(state)
  })
})

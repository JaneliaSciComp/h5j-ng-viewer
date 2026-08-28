import { describe, expect, it } from "vitest"
import { initialState, reducer } from "@/state/reducer"
import type { AppState } from "@/state/reducer"
import {
  cameraMoved,
  channelPicked,
  channelReady,
  ingestDetails,
  launchParsed,
  ingestDone,
  ingestFailed,
  ingestPhase,
  ingestProgress,
  ingestStarted,
  ingestStats,
  ingestWarnings,
  visibilityChanged,
  volumeRenderingToggled,
  projectionSamplesChanged,
  colorChanged,
  sourceFailed,
  sourceOpened,
  sourceOpening,
  viewerReady,
} from "@/state/actions"
import type { Action } from "@/state/actions"
import type { ChannelStats } from "@/lib/stats"
import { PROJECTION_SAMPLE_STEPS } from "@/lib/projection"
import type { H5JInfo } from "@/types"
import { NO_PARAMS } from "@/lib/url"

/** Apply a sequence of actions, which is how every real transition arrives. */
function run(actions: Action[], from: AppState = initialState): AppState {
  return actions.reduce(reducer, from)
}

const info: H5JInfo = {
  channels: [{ name: "Channel_0" }, { name: "Channel_1" }],
  nominalSize: { x: 256, y: 128, z: 64 },
  voxelSize: { x: 0.44, y: 0.44, z: 0.44 },
  channelSpec: "rg",
  attrs: {},
}

const stats = (max: number): ChannelStats => ({
  min: 0,
  max,
  lower: 0,
  upper: max,
  nonZeroFraction: 0.5,
  voxels: 100,
})

describe("opening a source", () => {
  it("shows every channel when the URL did not say otherwise", () => {
    const state = run([sourceOpening(), sourceOpened(info, "stack.h5j", null)])
    expect(state.controls.visible).toEqual([true, true])
    expect(state.source.name).toBe("stack.h5j")
  })

  it("shows only the channels chs asked for", () => {
    const state = run([
      launchParsed({ ...NO_PARAMS, h5jUrl: "x", channels: [1] }),
      sourceOpening(),
      sourceOpened(info, "stack.h5j", "x"),
    ])
    expect(state.controls.visible).toEqual([false, true])
  })

  it("reports a failure without wiping the previous selection state", () => {
    const state = run([sourceFailed("network is down")])
    expect(state.ingest.error).toBe("network is down")
    expect(state.ingest.detail).toBeUndefined()
  })
})

describe("diagnostics do not survive into the next run", () => {
  // The old component appended to its warnings/details arrays and reset neither, so a
  // second conversion showed the first one's numbers mixed in with its own.
  const afterFirstRun = run([
    sourceOpening(),
    sourceOpened(info, "first.h5j", null),
    ingestStarted(1),
    ingestWarnings(["voxel_size is missing"]),
    ingestDetails(["Channel_0: 0–4095"]),
    ingestStats(0, stats(4095)),
    viewerReady("first-abc", '{"layers":[]}', "256×128×64"),
    ingestDone(),
  ])

  it("has the first run's diagnostics while it is the current run", () => {
    expect(afterFirstRun.ingest.warnings).toHaveLength(1)
    expect(afterFirstRun.ingest.details).toHaveLength(1)
    expect(afterFirstRun.dataset.id).toBe("first-abc")
  })

  it("clears them when a new source is opened", () => {
    const state = run([sourceOpening()], afterFirstRun)
    expect(state.ingest.warnings).toEqual([])
    expect(state.ingest.details).toEqual([])
    expect(state.ingest.error).toBeNull()
    expect(state.dataset.id).toBeNull()
    expect(state.dataset.geometry).toBeNull()
    expect(state.dataset.stats).toEqual([])
  })

  it("clears them when a second conversion starts from the same source", () => {
    const state = run([ingestStarted(2)], afterFirstRun)
    expect(state.ingest.warnings).toEqual([])
    expect(state.ingest.details).toEqual([])
    expect(state.dataset.viewerState).toBeNull()
    // The source and what is shown are untouched: same file, different conversion.
    expect(state.controls.visible).toEqual([true, true])
  })
})

describe("which channel the controls act on", () => {
  it("has no target before anything is ready", () => {
    const state = run([sourceOpening(), sourceOpened(info, "s.h5j", null)])
    expect(state.ui.pickedChannel).toBeNull()
  })

  it("adopts the first channel that becomes readable", () => {
    // Conversion runs visible-first, so the first ready channel is one worth showing.
    const state = run([channelReady(1)])
    expect(state.ui.pickedChannel).toBe(1)
  })

  it("leaves a later arrival alone", () => {
    const state = run([channelReady(1), channelReady(0)])
    expect(state.ui.pickedChannel).toBe(1)
  })

  it("does not override a pick the user made", () => {
    const state = run([channelReady(1), channelPicked(0), channelReady(2)])
    expect(state.ui.pickedChannel).toBe(0)
  })

  it("forgets the pick when a new conversion starts", () => {
    // Nothing is readable at that point, so nothing can be edited.
    const state = run([channelReady(1), channelPicked(1), ingestStarted(2)])
    expect(state.ui.pickedChannel).toBeNull()
  })

  it("forgets the pick when a new source is opened", () => {
    const state = run([channelReady(0), sourceOpening()])
    expect(state.ui.pickedChannel).toBeNull()
  })
})

describe("the download is not a silent gap", () => {
  it("reports a phase while the container is being fetched and parsed", () => {
    // Nothing else covers this span: the ingest worker only hears about a channel once
    // it has been decoded, so without a phase here the bar sits blank for a minute on a
    // large file.
    expect(run([sourceOpening()]).ingest.phase).toBe("fetching")
  })

  it("stops reporting it once the container is open", () => {
    const state = run([sourceOpening(), sourceOpened(info, "s.h5j", null)])
    expect(state.ingest.phase).toBe("idle")
  })

  it("stops reporting it when the fetch fails", () => {
    const state = run([sourceOpening(), sourceFailed("404")])
    expect(state.ingest.phase).toBe("idle")
    expect(state.ingest.error).toBe("404")
  })
})

describe("channel readiness", () => {
  it("marks only the channel that finished", () => {
    const state = run([channelReady(2)])
    expect(state.dataset.ready[0]).toBeUndefined()
    expect(state.dataset.ready[2]).toBe(true)
  })

  it("forgets readiness when a new conversion starts", () => {
    const state = run([channelReady(0), ingestStarted(2)])
    expect(state.dataset.ready).toEqual([])
  })
})

describe("ingest progress", () => {
  it("accumulates warnings and details in arrival order", () => {
    const state = run([
      ingestWarnings(["first"]),
      ingestDetails(["a"]),
      ingestWarnings(["second"]),
      ingestDetails(["b"]),
    ])
    expect(state.ingest.warnings).toEqual(["first", "second"])
    expect(state.ingest.details).toEqual(["a", "b"])
  })

  it("keeps per-channel stats sparse, indexed by c-axis position", () => {
    const state = run([ingestStats(1, stats(500))])
    expect(state.dataset.stats[0]).toBeUndefined()
    expect(state.dataset.stats[1]?.max).toBe(500)
  })

  it("clears the transient labels when a run finishes", () => {
    const state = run([
      ingestPhase("writing", "Level 1 of 3"),
      ingestProgress(0.5),
      ingestDone(),
    ])
    expect(state.ingest.phase).toBe("done")
    expect(state.ingest.fraction).toBeNull()
    expect(state.ingest.detail).toBeUndefined()
    expect(state.ingest.channelLabel).toBeUndefined()
  })

  it("returns to idle on failure, keeping what was already converted", () => {
    const state = run([
      ingestStarted(2),
      viewerReady("id-1", '{"layers":[]}', "256×128×64"),
      ingestProgress(0.4),
      ingestFailed("decode failed"),
    ])
    expect(state.ingest.phase).toBe("idle")
    expect(state.ingest.error).toBe("decode failed")
    expect(state.ingest.fraction).toBeNull()
    // The first channel is still on screen and still readable; only the rest is lost.
    expect(state.dataset.id).toBe("id-1")
  })
})

describe("the camera only ever flows one way", () => {
  it("records where the viewer is looking", () => {
    const state = run([cameraMoved([10, 20, 30], 2.5)])
    expect(state.camera).toEqual({ position: [10, 20, 30], zoom: 2.5 })
  })

  it("does not touch the rendering controls", () => {
    // If a camera move could change controls, the push effect would fire on every
    // mouse drag and the two wires would form a loop.
    const before = run([
      sourceOpened(info, "s.h5j", null),
      visibilityChanged([false, true]),
    ])
    const after = reducer(before, cameraMoved([1, 2, 3], 1))
    expect(after.controls).toBe(before.controls)
  })
})

describe("reducer purity", () => {
  it("never mutates the state it is given", () => {
    const before = JSON.stringify(initialState)
    run([
      sourceOpened(info, "stack.h5j", null),
      visibilityChanged([false, true]),
      ingestWarnings(["w"]),
      ingestStats(0, stats(10)),
    ])
    expect(JSON.stringify(initialState)).toBe(before)
  })

  it("returns the same object for an unknown action", () => {
    const unknown = { type: "NOT_AN_ACTION" } as unknown as Action
    expect(reducer(initialState, unknown)).toBe(initialState)
  })
})

describe("the 3D projection detail", () => {
  const opened = run([sourceOpened(info, "s.h5j", null)])

  it("starts at the coarsest step, which is the cheapest", () => {
    expect(opened.controls.projectionSamples).toBe(PROJECTION_SAMPLE_STEPS[0])
  })

  it("takes any step of the ladder", () => {
    for (const samples of PROJECTION_SAMPLE_STEPS) {
      expect(
        run([projectionSamplesChanged(samples)], opened).controls
          .projectionSamples
      ).toBe(samples)
    }
  })

  it("snaps a value off the ladder down to a real step", () => {
    // Never trusted from the caller: Neuroglancer's trackable throws outside its range
    // and its restoreState swallows the throw, reverting to the blockiest setting. A
    // value that cannot reach it cannot cause that.
    expect(
      run([projectionSamplesChanged(3000)], opened).controls.projectionSamples
    ).toBe(2048)
  })

  it("clamps below the ladder and above it rather than storing either", () => {
    expect(
      run([projectionSamplesChanged(1)], opened).controls.projectionSamples
    ).toBe(PROJECTION_SAMPLE_STEPS[0])
    expect(
      run([projectionSamplesChanged(1e9)], opened).controls.projectionSamples
    ).toBe(PROJECTION_SAMPLE_STEPS[PROJECTION_SAMPLE_STEPS.length - 1])
  })

  it("is independent of the toggle, so detail survives turning 3D off and on", () => {
    const state = run(
      [
        volumeRenderingToggled(true),
        projectionSamplesChanged(4096),
        volumeRenderingToggled(false),
        volumeRenderingToggled(true),
      ],
      opened
    )
    expect(state.controls.projectionSamples).toBe(4096)
  })
})

describe("the 3D projection toggle", () => {
  const opened = run([sourceOpened(info, "s.h5j", null)])

  it("starts off, because projecting costs GPU time nobody asked for", () => {
    expect(opened.controls.volumeRendering).toBe(false)
  })

  it("turns on and off again", () => {
    const on = run([volumeRenderingToggled(true)], opened)
    expect(on.controls.volumeRendering).toBe(true)
    expect(
      run([volumeRenderingToggled(false)], on).controls.volumeRendering
    ).toBe(false)
  })

  it("leaves every per-channel control alone", () => {
    // One view-wide choice living beside the per-channel arrays: flipping it must not
    // disturb a color or a visibility the user has set.
    const edited = run(
      [visibilityChanged([false, true]), colorChanged(1, "#123456")],
      opened
    )
    const toggled = run([volumeRenderingToggled(true)], edited)
    expect(toggled.controls.visible).toEqual(edited.controls.visible)
    expect(toggled.controls.colors).toEqual(edited.controls.colors)
    expect(toggled.controls.opacity).toEqual(edited.controls.opacity)
  })
})

import { describe, expect, it } from "vitest"
import { initialState, reducer } from "@/state/reducer"
import type { AppState } from "@/state/reducer"
import {
  channelPicked,
  channelReady,
  sourceOpened,
  visibilityChanged,
} from "@/state/actions"
import type { Action } from "@/state/actions"
import { ingestDims, viewerReady } from "@/state/actions"
import {
  layerDataset,
  pickedChannel,
  projectedBytes,
  zoomToPersist,
} from "@/state/selectors"
import type { H5JInfo, ResolvedDims } from "@/types"

function run(actions: Action[], from: AppState = initialState): AppState {
  return actions.reduce(reducer, from)
}

const info: H5JInfo = {
  channels: [{ name: "Channel_0" }, { name: "Channel_1" }],
  nominalSize: { x: 64, y: 64, z: 64 },
  voxelSize: { x: 1, y: 1, z: 1 },
  channelSpec: "rg",
  attrs: {},
}

describe("pickedChannel", () => {
  const opened = [sourceOpened(info, "s.h5j", null)]

  it("is null until a channel is both picked and readable", () => {
    expect(pickedChannel(run(opened))).toBeNull()
  })

  it("describes everything a control needs to render", () => {
    const state = run([...opened, channelReady(1)])
    expect(pickedChannel(state)).toEqual({
      index: 1,
      name: "Channel_1",
      visible: true,
      // Two-channel stacks default to magenta/green, so channel 1 is green.
      color: "#00ff00",
    })
  })

  it("reflects the picked channel's visibility, not the first channel's", () => {
    const state = run([
      ...opened,
      channelReady(1),
      visibilityChanged([true, false]),
    ])
    expect(pickedChannel(state)?.visible).toBe(false)
  })

  it("refuses a pick that is not readable yet", () => {
    // Reachable if a pick outlives the run it was made in; handing it to the eye and
    // swatch would let the user edit a channel that cannot be shown.
    const state = run([...opened, channelReady(0), channelPicked(1)])
    expect(pickedChannel(state)).toBeNull()
  })

  it("refuses a pick that is out of range for this container", () => {
    const state = run([...opened, channelReady(0), channelPicked(7)])
    expect(pickedChannel(state)).toBeNull()
  })

  it("is null before any container has been opened", () => {
    expect(pickedChannel(run([channelReady(0)]))).toBeNull()
  })
})

describe("projectedBytes", () => {
  const opened = run([sourceOpened(info, "s.h5j", null)])

  it("is the whole container before anything has converted", () => {
    expect(projectedBytes(opened)).toBeGreaterThan(0)
  })

  it("shrinks as channels land, rather than vanishing at the first one", () => {
    // The regression this pins: it used to return null as soon as `viewerState` was
    // set. That was correct while the viewer mounted after the LAST channel, but it now
    // mounts after the first — so the storage gauge lost its projection for the whole
    // stretch where "will this fit" is the question being asked.
    const mounted = run(
      [viewerReady("ds1", "{}", "64×64×64"), channelReady(0)],
      opened
    )
    const whole = projectedBytes(opened)
    const half = projectedBytes(mounted)
    expect(half).not.toBeNull()
    expect(half!).toBeLessThan(whole!)
    expect(half!).toBeCloseTo(whole! / 2, -3)
  })

  it("is null once every channel has converted", () => {
    const done = run([channelReady(0), channelReady(1)], opened)
    expect(projectedBytes(done)).toBeNull()
  })

  it("is null before a container is open", () => {
    expect(projectedBytes(initialState)).toBeNull()
  })
})

describe("layerDataset", () => {
  const dims: ResolvedDims = {
    size: { x: 64, y: 64, z: 64 },
    padX: 64,
    padY: 64,
    voxelSize: { x: 0.5, y: 0.5, z: 1 },
    warnings: [],
    notes: [],
  }
  const converting = [
    sourceOpened(info, "s.h5j", null),
    ingestDims(dims),
    viewerReady("ds1", "{}", "64×64×64"),
  ]

  it("is null before there is anything to point a layer at", () => {
    expect(layerDataset(initialState, "http://x")).toBeNull()
  })

  it("reports readiness per channel, so an unconverted one stays dark", () => {
    const state = run([...converting, channelReady(0)])
    expect(layerDataset(state, "http://x")?.ready).toEqual([true, false])
  })

  it("fills in a channel the run has not reached at all", () => {
    // `ready` is written sparsely as channels land, and a hole must read as false
    // rather than undefined -- a layer built from undefined would be neither visibly
    // shown nor deliberately hidden.
    const state = run(converting)
    expect(layerDataset(state, "http://x")?.ready).toEqual([false, false])
  })

  it("names one channel per entry, in container order", () => {
    const state = run([...converting, channelReady(0), channelReady(1)])
    expect(layerDataset(state, "http://x")?.channelNames).toEqual([
      "Channel_0",
      "Channel_1",
    ])
  })
})

describe("zoomToPersist keeps the fitted default out of the URL", () => {
  it("writes nothing before the viewer has reported a zoom", () => {
    expect(zoomToPersist(null, null)).toBeNull()
  })

  it("omits a zoom still sitting on the fitted default", () => {
    expect(zoomToPersist(1.4, 1.4)).toBeNull()
  })

  it("persists a zoom the user has moved off the default", () => {
    expect(zoomToPersist(3.2, 1.4)).toBe(3.2)
  })

  it("persists a pinned zoom when no fit ran to set a default", () => {
    // A shared link pinned a zoom, so the fit was skipped and there is no default; the
    // zoom is the user's and must survive the round-trip.
    expect(zoomToPersist(2.0, null)).toBe(2.0)
  })
})

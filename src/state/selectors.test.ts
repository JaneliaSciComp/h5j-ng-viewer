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
import { layerDataset, pickedChannel } from "@/state/selectors"
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
      // The default palette, indexed by the channel's own position.
      color: "#4294ff",
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

describe("layerDataset", () => {
  const dims: ResolvedDims = {
    size: { x: 64, y: 64, z: 64 },
    padX: 64,
    padY: 64,
    voxelSize: { x: 0.5, y: 0.5, z: 1 },
    warnings: [],
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

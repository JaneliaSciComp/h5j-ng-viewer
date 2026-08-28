// The chips' decision logic, tested without a DOM. The JSX around it is a thin mapping
// from these two functions to attributes, which is deliberate: the part worth pinning is
// which of the five states a channel is in and what the tooltip promises the next click
// will do.

import { describe, expect, it } from "vitest"
import { chipState, chipTitle } from "@/components/chipState"

describe("chipState", () => {
  const status = (over: {
    ready?: boolean[]
    visible?: boolean[]
    convertingIndex?: number | null
  }) => ({
    ready: over.ready ?? [],
    visible: over.visible ?? [],
    convertingIndex: over.convertingIndex ?? null,
  })

  it("is queued before conversion reaches the channel", () => {
    expect(chipState(2, status({ convertingIndex: 0 }))).toBe("queued")
  })

  it("is converting only for the channel actually in flight", () => {
    const s = status({ convertingIndex: 1 })
    expect(chipState(1, s)).toBe("converting")
    expect(chipState(0, s)).toBe("queued")
  })

  it("becomes visible or hidden once the channel is ready", () => {
    const ready = [true, true]
    expect(chipState(0, status({ ready, visible: [true, false] }))).toBe(
      "visible"
    )
    expect(chipState(1, status({ ready, visible: [true, false] }))).toBe(
      "hidden"
    )
  })

  it("treats a missing visibility flag as visible", () => {
    // A short array must not read as "everything is hidden".
    expect(chipState(0, status({ ready: [true] }))).toBe("visible")
  })

  it("reports load state ahead of visibility", () => {
    // A channel can be marked visible while its data is still arriving; the chip has to
    // say "converting", because switching it on would show fill_value zeros.
    expect(
      chipState(0, status({ ready: [], visible: [true], convertingIndex: 0 }))
    ).toBe("converting")
  })
})

describe("chipTitle", () => {
  it("names the action the next click performs", () => {
    expect(chipTitle("Channel_0", "visible", null)).toBe(
      "Channel_0 — click to hide, right-click to edit"
    )
    expect(chipTitle("Channel_0", "hidden", null)).toBe(
      "Channel_0 — click to show, right-click to edit"
    )
  })

  it("reports progress while converting", () => {
    expect(chipTitle("Channel_2", "converting", 0.423)).toBe(
      "Channel_2 — converting, 42%"
    )
  })

  it("omits a percentage it does not have", () => {
    expect(chipTitle("Channel_2", "converting", null)).toBe(
      "Channel_2 — converting"
    )
  })

  it("says a queued channel is waiting rather than offering a click", () => {
    expect(chipTitle("Channel_3", "queued", null)).toBe(
      "Channel_3 — waiting to convert"
    )
  })
})

import { describe, expect, it } from "vitest"
import { splitForMiddleElision } from "@/components/elideName"

const REAL =
  "R80A07-20190611_64_A2-m-40x-central-GAL4-JRC2018_Unisex_20x_HR-aligned_stack.h5j"

describe("splitForMiddleElision", () => {
  it("loses nothing: head + tail is always the original", () => {
    for (const name of [
      REAL,
      "a.h5j",
      "no-separators-at-all-anywhere-in-this-name",
      "x".repeat(200),
      "",
    ]) {
      const [head, tail] = splitForMiddleElision(name)
      expect(head + tail).toBe(name)
    }
  })

  it("keeps a short name whole, with nothing to protect", () => {
    // Below the threshold the head never has to shrink, so splitting would only add a
    // seam the browser could break a line at.
    expect(splitForMiddleElision("brain.h5j")).toEqual(["brain.h5j", ""])
  })

  it("cuts a real FlyLight name on a word boundary", () => {
    const [head, tail] = splitForMiddleElision(REAL)
    expect(tail).toBe("_stack.h5j")
    expect(head).toBe(
      "R80A07-20190611_64_A2-m-40x-central-GAL4-JRC2018_Unisex_20x_HR-aligned"
    )
  })

  it("keeps the extension in the tail, which is the point of eliding the middle", () => {
    for (const name of [REAL, "some_other_long_file_name_here.h5j"]) {
      expect(splitForMiddleElision(name)[1]).toContain(".h5j")
    }
  })

  it("keeps the identifying front in the head", () => {
    // These names are identified by their leading line and sample, so the head is the
    // part worth reading and the tail should stay as short as the rule allows.
    expect(splitForMiddleElision(REAL)[0]).toContain("R80A07-20190611_64_A2")
  })

  it("falls back to a character count when nothing in range is a boundary", () => {
    const name = "abcdefghij" + "k".repeat(40)
    const [head, tail] = splitForMiddleElision(name)
    expect(tail).toBe("k".repeat(10))
    expect(head).toBe("abcdefghij" + "k".repeat(30))
  })

  it("never hands the tail more than the cap, however far the boundary is", () => {
    // A separator just outside the window must not pull the whole name into the tail,
    // which would leave nothing able to shrink and overflow the bar.
    const name = "start-" + "z".repeat(60)
    expect(splitForMiddleElision(name)[1].length).toBeLessThanOrEqual(24)
  })

  it("always leaves the tail long enough to be worth protecting", () => {
    for (const name of [REAL, "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p.h5j"]) {
      expect(splitForMiddleElision(name)[1].length).toBeGreaterThanOrEqual(10)
    }
  })
})

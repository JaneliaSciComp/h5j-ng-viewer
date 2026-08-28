import { describe, expect, it } from "vitest"
import {
  basenameOf,
  NO_PARAMS,
  parseParams,
  serializeParams,
  visibilityFor,
  visibleIndices,
} from "@/lib/url"
import type { LaunchParams } from "@/lib/url"

const H5J =
  "https://s3.amazonaws.com/janelia-flylight-imagery/Split-GAL4+Omnibus+Broad/" +
  "SS21347/SS21347-20151117_32_D4-m-20x-brain-Split_GAL4-JRC2018_Unisex_20x_HR" +
  "-aligned_stack.h5j"

describe("parseParams", () => {
  it("reads the launch URL from the requirements verbatim", () => {
    const launch = parseParams(
      `?h5j=${encodeURIComponent(H5J)}&chs=${encodeURIComponent("0,1")}`
    )
    expect(launch.h5jUrl).toBe(H5J)
    expect(launch.channels).toEqual([0, 1])
  })

  it("treats an absent chs as 'all channels' rather than 'none'", () => {
    expect(parseParams(`?h5j=${encodeURIComponent(H5J)}`).channels).toBeNull()
  })

  it("returns nothing at all for an empty search string", () => {
    expect(parseParams("")).toEqual(NO_PARAMS)
  })

  it("ignores parameters it does not recognize", () => {
    const launch = parseParams(`?h5j=${encodeURIComponent(H5J)}&surprise=42`)
    expect(launch.h5jUrl).toBe(H5J)
  })

  it("drops malformed channel indices instead of failing the load", () => {
    expect(parseParams("?h5j=x&chs=0,two,-1,3.5,2").channels).toEqual([0, 2])
    expect(parseParams("?h5j=x&chs=nonsense").channels).toBeNull()
    // Duplicates would give a channel two entries on the c axis.
    expect(parseParams("?h5j=x&chs=1,1,2").channels).toEqual([1, 2])
  })

  it("keeps color positions when only some entries are valid", () => {
    // Dropping the bad entry would shift every later color onto the wrong channel.
    expect(parseParams("?h5j=x&col=ff00ff,zzz,00ff00").colors).toEqual([
      "#ff00ff",
      null,
      "#00ff00",
    ])
    expect(parseParams("?h5j=x&col=#ff0000").colors).toEqual(["#ff0000"])
    expect(parseParams("?h5j=x&col=zzz").colors).toBeNull()
  })

  it("accepts a position only as three finite numbers", () => {
    expect(parseParams("?h5j=x&pos=605,283,87").position).toEqual([
      605, 283, 87,
    ])
    expect(parseParams("?h5j=x&pos=605,283").position).toBeNull()
    expect(parseParams("?h5j=x&pos=a,b,c").position).toBeNull()
  })

  it("rejects a zoom that is not a positive number", () => {
    expect(parseParams("?h5j=x&zoom=2.5").zoom).toBe(2.5)
    expect(parseParams("?h5j=x&zoom=0").zoom).toBeNull()
    expect(parseParams("?h5j=x&zoom=-1").zoom).toBeNull()
  })
})

describe("serializeParams", () => {
  const full: LaunchParams = {
    h5jUrl: H5J,
    channels: [0, 1],
    colors: ["#ff00ff", null, "#00ff00"],
    position: [605, 283, 87],
    zoom: 1,
  }

  it("round-trips every parameter", () => {
    expect(parseParams(serializeParams(full))).toEqual(full)
  })

  it("round-trips a launch that carries only the file", () => {
    const minimal: LaunchParams = { ...NO_PARAMS, h5jUrl: H5J }
    expect(parseParams(serializeParams(minimal))).toEqual(minimal)
  })

  it("emits nothing without a file, since the rest could not be acted on", () => {
    expect(serializeParams({ ...full, h5jUrl: null })).toBe("")
  })

  it("writes colors without the leading '#'", () => {
    expect(serializeParams(full)).toContain("col=ff00ff%2C%2C00ff00")
  })
})

describe("basenameOf", () => {
  it("takes the last path segment of the example S3 URL", () => {
    expect(basenameOf(H5J)).toBe(
      "SS21347-20151117_32_D4-m-20x-brain-Split_GAL4-JRC2018_Unisex_20x_HR" +
        "-aligned_stack.h5j"
    )
  })

  it("strips a presigned query and any fragment", () => {
    expect(
      basenameOf("https://host/a/stack.h5j?X-Amz-Signature=deadbeef")
    ).toBe("stack.h5j")
    expect(basenameOf("https://host/a/stack.h5j#anchor")).toBe("stack.h5j")
  })

  it("decodes percent-escapes but leaves a literal '+' alone", () => {
    // '+' means space only in a query string; in a path it is a plus sign, and these
    // Janelia paths really do contain them ("Split-GAL4+Omnibus+Broad").
    expect(basenameOf("https://host/my%20stack.h5j")).toBe("my stack.h5j")
    expect(basenameOf("https://host/Split-GAL4+Omnibus.h5j")).toBe(
      "Split-GAL4+Omnibus.h5j"
    )
  })

  it("passes a plain file name through unchanged", () => {
    expect(basenameOf("stack.h5j")).toBe("stack.h5j")
  })

  it("survives a malformed escape rather than throwing", () => {
    expect(basenameOf("https://host/100%.h5j")).toBe("100%.h5j")
  })
})

describe("visibility from chs", () => {
  it("shows only the requested channels", () => {
    expect(visibilityFor(4, [0, 2])).toEqual([true, false, true, false])
  })

  it("shows everything when chs said nothing", () => {
    expect(visibilityFor(3, null)).toEqual([true, true, true])
  })

  it("ignores an out-of-range index rather than failing the load", () => {
    expect(visibilityFor(2, [1, 99])).toEqual([false, true])
  })

  it("falls back to showing everything when no index is usable", () => {
    // A blank viewer is a worse answer to a broken link than an over-full one.
    expect(visibilityFor(2, [99])).toEqual([true, true])
  })

  it("leaves chs out of the URL when everything is visible", () => {
    expect(visibleIndices([true, true])).toBeNull()
    expect(visibleIndices([])).toBeNull()
  })

  it("round-trips a partial selection", () => {
    const visible = visibilityFor(4, [1, 3])
    expect(visibleIndices(visible)).toEqual([1, 3])
  })
})

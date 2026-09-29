import { describe, expect, it } from "vitest"
import { describeStorage, formatEnvironment } from "@/lib/environment"
import type { Environment, StorageFacts } from "@/lib/environment"

const GB = 1024 ** 3

function facts(overrides: Partial<StorageFacts> = {}): StorageFacts {
  return { usage: 5 * GB, quota: 10 * GB, persisted: true, ...overrides }
}

describe("describeStorage", () => {
  it("says the quota was not the limit when almost nothing was in use", () => {
    // The report this exists for: "8.4 KB of 10.0 GB used" beside "No space available".
    // Those two facts side by side are a contradiction the reader should not have to
    // resolve, and every follow-up question was about resolving it.
    const lines = describeStorage(
      facts({ usage: 8600, persisted: false })
    ).join(" ")
    expect(lines).toMatch(/quota was not the limit/i)
    expect(lines).toMatch(/free disk space/i)
    // No byte count was given, so there is nothing to call a ceiling.
    expect(lines).not.toMatch(/fixed ceiling/i)
  })

  it("stays quiet about the quota when storage really was full", () => {
    const lines = describeStorage(facts({ usage: 9.5 * GB }))
    expect(lines.join(" ")).not.toMatch(/not the limit/i)
  })

  it("names private windows when storage is not persisted", () => {
    const lines = describeStorage(facts({ persisted: false }))
    expect(lines.join(" ")).toMatch(/private and guest windows/i)
  })

  it("concludes nothing when the browser reported no quota", () => {
    // Better than dividing by zero and asserting that storage is 0% or Infinity% full.
    const lines = describeStorage(facts({ quota: 0 }))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/nothing can be concluded/i)
  })

  it("points elsewhere when the space belongs to another storage API", () => {
    const lines = describeStorage(
      facts({
        usage: 9 * GB,
        usageDetails: { fileSystem: 1000, indexedDB: 9 * GB },
      })
    )
    expect(lines.join(" ")).toMatch(/something other than/i)
  })

  it("does not blame another API when the volumes are in fact ours", () => {
    const lines = describeStorage(
      facts({ usage: 9 * GB, usageDetails: { fileSystem: 9 * GB } })
    )
    expect(lines.join(" ")).not.toMatch(/something other than/i)
  })

  it("reports how far the write got, which measures the real limit", () => {
    const lines = describeStorage(facts(), 123456)
    expect(lines.join(" ")).toContain("123456 bytes")
  })

  it("calls a power-of-two failure point a ceiling, not a full disk", () => {
    // Measured from a real report: the write stopped at exactly 2^28 while storage was
    // 2.4% full and the disk had 17.69 GB free. Telling that person to check disk space
    // -- which the previous wording did -- wasted their time.
    const lines = describeStorage(
      { usage: 268453753, quota: 11005871993, persisted: false },
      268435456
    ).join(" ")
    expect(lines).toContain("exactly 256 MiB")
    expect(lines).toMatch(/fixed ceiling/i)
    expect(lines).toMatch(/free disk space is not the problem/i)
    expect(lines).not.toMatch(/disk is nearly full/i)
  })

  it("still blames the disk when the failure point is not round", () => {
    const lines = describeStorage(
      { usage: 8600, quota: 10 * GB, persisted: false },
      91234567
    ).join(" ")
    expect(lines).toMatch(/check the machine's free disk space/i)
    expect(lines).not.toMatch(/fixed ceiling/i)
  })

  it("does not cry ceiling for a small power of two", () => {
    // Chunks are themselves powers of two, so every failure lands on a binary
    // boundary. Only a large round total is evidence of anything.
    const lines = describeStorage(
      { usage: 8600, quota: 10 * GB, persisted: true },
      524288
    )
    expect(lines.join(" ")).not.toMatch(/fixed ceiling/i)
  })

  it("omits that line when the failure carried no byte count", () => {
    expect(describeStorage(facts()).join(" ")).not.toMatch(/stopped after/i)
  })
})

describe("formatEnvironment", () => {
  const env: Environment = {
    userAgent: "Mozilla/5.0 …",
    crossOriginIsolated: true,
    serviceWorkerControlled: true,
    storage: facts(),
  }

  it("is plain lines, pasteable into a bug report", () => {
    const text = formatEnvironment(env)
    expect(text).toContain("userAgent: Mozilla/5.0 …")
    expect(text).toContain("crossOriginIsolated: true")
    expect(text.split("\n").every((l) => l.includes(": "))).toBe(true)
  })

  it("keeps `false` rather than dropping it as empty", () => {
    // These two are the ones worth knowing when false, so a truthiness filter here
    // would hide exactly the interesting cases.
    const text = formatEnvironment({
      ...env,
      crossOriginIsolated: false,
      serviceWorkerControlled: false,
    })
    expect(text).toContain("crossOriginIsolated: false")
    expect(text).toContain("serviceWorkerControlled: false")
  })

  it("omits fields the browser does not expose", () => {
    expect(formatEnvironment(env)).not.toContain("deviceMemory")
  })
})

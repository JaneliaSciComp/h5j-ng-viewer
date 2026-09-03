import { describe, expect, it } from "vitest"
import { applyPlan, planEviction } from "@/lib/evict"
import type { DatasetRecord } from "@/lib/evict"

const GB = 1024 ** 3

function record(
  id: string,
  overrides: Partial<DatasetRecord> = {}
): DatasetRecord {
  return { id, bytes: GB, lastUsedAt: 1000, complete: true, ...overrides }
}

describe("planEviction", () => {
  it("evicts nothing when there is already room", () => {
    const plan = planEviction([record("a"), record("b")], {
      needed: GB,
      free: 2 * GB,
    })
    expect(plan.evict).toEqual([])
    expect(plan.sufficient).toBe(true)
  })

  it("takes the least recently used first", () => {
    const plan = planEviction(
      [
        record("new", { lastUsedAt: 3000 }),
        record("old", { lastUsedAt: 1000 }),
        record("mid", { lastUsedAt: 2000 }),
      ],
      { needed: 2 * GB, free: 0 }
    )
    expect(plan.evict).toEqual(["old", "mid"])
  })

  it("stops as soon as there is room, rather than clearing everything", () => {
    const plan = planEviction(
      [
        record("a", { lastUsedAt: 1000 }),
        record("b", { lastUsedAt: 2000 }),
        record("c", { lastUsedAt: 3000 }),
      ],
      { needed: GB, free: 0 }
    )
    expect(plan.evict).toEqual(["a"])
    expect(plan.reclaimed).toBe(GB)
  })

  it("sweeps incomplete datasets before any complete one, however recent", () => {
    // Debris from a failed run cannot be viewed, so discarding it costs nothing anyone
    // wants -- and on a machine that has been failing for want of space it is often
    // most of what is there.
    const plan = planEviction(
      [
        record("good-old", { lastUsedAt: 1 }),
        record("debris", { lastUsedAt: 9999, complete: false }),
      ],
      { needed: GB, free: 0 }
    )
    expect(plan.evict).toEqual(["debris"])
  })

  it("orders incomplete datasets among themselves by age too", () => {
    const plan = planEviction(
      [
        record("debris-new", { lastUsedAt: 2000, complete: false }),
        record("debris-old", { lastUsedAt: 1000, complete: false }),
      ],
      { needed: 2 * GB, free: 0 }
    )
    expect(plan.evict).toEqual(["debris-old", "debris-new"])
  })

  it("never evicts a kept dataset, even when it is the oldest", () => {
    // The mounted dataset is being served to Neuroglancer chunk by chunk. Removing it
    // under a live layer turns a working view black with no error anywhere.
    const plan = planEviction(
      [
        record("mounted", { lastUsedAt: 1 }),
        record("other", { lastUsedAt: 5000 }),
      ],
      { needed: GB, free: 0, keep: ["mounted"] }
    )
    expect(plan.evict).toEqual(["other"])
  })

  it("reports insufficiency rather than pretending, when everything is kept", () => {
    const plan = planEviction([record("mounted", { lastUsedAt: 1 })], {
      needed: GB,
      free: 0,
      keep: ["mounted"],
    })
    expect(plan.evict).toEqual([])
    expect(plan.sufficient).toBe(false)
  })

  it("says how much it would have freed when that is not enough", () => {
    // The caller reports this figure, which is what makes "clearing everything would
    // only recover 2 GB" a useful thing to be told instead of a bare refusal.
    const plan = planEviction([record("a"), record("b")], {
      needed: 10 * GB,
      free: 0,
    })
    expect(plan.sufficient).toBe(false)
    expect(plan.reclaimed).toBe(2 * GB)
  })

  it("counts the free space it already has toward the target", () => {
    const plan = planEviction([record("a"), record("b")], {
      needed: 3 * GB,
      free: 2 * GB,
    })
    expect(plan.evict).toEqual(["a"])
  })

  it("is a total order, so the same input always plans the same way", () => {
    const tied = [
      record("b", { lastUsedAt: 1000 }),
      record("a", { lastUsedAt: 1000 }),
      record("c", { lastUsedAt: 1000 }),
    ]
    expect(planEviction(tied, { needed: 2 * GB, free: 0 }).evict).toEqual([
      "a",
      "b",
    ])
  })

  it("treats a nonsensical size as reclaiming nothing", () => {
    const plan = planEviction(
      [record("bad", { bytes: -5, lastUsedAt: 1 }), record("good")],
      { needed: GB, free: 0 }
    )
    expect(plan.reclaimed).toBe(GB)
    expect(plan.evict).toEqual(["bad", "good"])
  })

  it("does not mutate what it was given", () => {
    const datasets = [
      record("b", { lastUsedAt: 2000 }),
      record("a", { lastUsedAt: 1000 }),
    ]
    planEviction(datasets, { needed: 5 * GB, free: 0 })
    expect(datasets.map((d) => d.id)).toEqual(["b", "a"])
  })
})

describe("applyPlan", () => {
  it("carries out a plan that gets there", () => {
    const plan = planEviction([record("a")], { needed: GB, free: 0 })
    expect(applyPlan(plan)).toEqual(["a"])
  })

  it("carries out NOTHING when the plan falls short", () => {
    // The failure this exists to prevent: greedily evicting until the disk runs out
    // would, in the worst case, delete every volume the user has and then fail anyway
    // -- costing them everything and buying nothing. Refuse while their data is intact.
    const plan = planEviction([record("a"), record("b")], {
      needed: 100 * GB,
      free: 0,
    })
    expect(plan.evict.length).toBeGreaterThan(0)
    expect(applyPlan(plan)).toEqual([])
  })
})

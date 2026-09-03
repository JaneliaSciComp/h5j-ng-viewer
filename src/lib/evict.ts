// Deciding which converted volumes to discard to make room for a new one.
//
// Kept apart from the code that does the discarding, and pure, because the cost of a
// wrong answer here is destroying hours of conversion -- and a rule that can only be
// exercised against a real Origin Private File System is a rule that does not get
// exercised.

/** What eviction needs to know about one converted dataset. */
export interface DatasetRecord {
  id: string
  /** Bytes it occupies. */
  bytes: number
  /** When it was last opened, in epoch milliseconds. */
  lastUsedAt: number
  /**
   * Whether conversion finished. An unfinished dataset is not a cache entry that might
   * be wanted again -- it is debris from a failed or abandoned run, unreadable by any
   * layer, and it goes first regardless of age.
   */
  complete: boolean
}

export interface EvictionPlan {
  /** Dataset ids to remove, in the order they should go. */
  evict: string[]
  /** Bytes those datasets occupy. */
  reclaimed: number
  /**
   * Whether the plan actually gets there. False means even removing everything
   * evictable leaves too little, and the caller should evict NOTHING -- see below.
   */
  sufficient: boolean
}

/**
 * Least-recently-used eviction, with debris swept first.
 *
 * The ordering is: incomplete datasets by age, then complete ones by how long ago they
 * were last opened. Sweeping the incomplete ones first costs nothing anybody wants --
 * they cannot be viewed -- and on a machine that has been failing for lack of space
 * they are often most of what is there.
 *
 * `keep` is not a preference. A dataset the viewer is currently mounted on is being
 * served to Neuroglancer chunk by chunk; deleting it under a live layer turns a working
 * view into a black one with no error. The dataset being written right now is the other
 * case.
 *
 * When even the full sweep is not enough, this returns `sufficient: false` **with the
 * plan still populated** so a caller can say how much it would have reclaimed -- but the
 * caller must not carry it out. Deleting every volume the user has and then failing
 * anyway is strictly worse than failing immediately: it costs them everything and buys
 * nothing. `planEviction` cannot enforce that, so callers do; `applyPlan` below is the
 * one place that decision lives.
 */
export function planEviction(
  datasets: DatasetRecord[],
  opts: { needed: number; free: number; keep?: Iterable<string> }
): EvictionPlan {
  const keep = new Set(opts.keep ?? [])
  const shortfall = opts.needed - opts.free
  if (shortfall <= 0) return { evict: [], reclaimed: 0, sufficient: true }

  const candidates = datasets
    .filter((dataset) => !keep.has(dataset.id))
    .sort(compare)

  const evict: string[] = []
  let reclaimed = 0
  for (const dataset of candidates) {
    evict.push(dataset.id)
    reclaimed += Math.max(0, dataset.bytes)
    if (reclaimed >= shortfall) break
  }

  return { evict, reclaimed, sufficient: reclaimed >= shortfall }
}

/** Debris before cache, then oldest use first. Ties broken by id so the order is total. */
function compare(a: DatasetRecord, b: DatasetRecord): number {
  if (a.complete !== b.complete) return a.complete ? 1 : -1
  if (a.lastUsedAt !== b.lastUsedAt) return a.lastUsedAt - b.lastUsedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The plan a caller should actually carry out: the same one, unless it would not have
 * been enough, in which case nothing.
 */
export function applyPlan(plan: EvictionPlan): string[] {
  return plan.sufficient ? plan.evict : []
}

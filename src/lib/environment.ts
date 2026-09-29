// Everything about the browser this app can ask for itself, gathered for a bug report.
//
// The alternative is asking the person who hit the problem to open DevTools and read
// values back, which is slow, error-prone, and does not happen at all if they are busy.
// The failure this exists for was reported as a screenshot of a dialog that showed
// "8.4 KB of 10.0 GB used" beside "No space available for this operation" -- a
// contradiction that the two numbers alone could not explain, and that every follow-up
// question was about.
//
// Nothing here throws. A diagnostic that can fail is a diagnostic that fires exactly
// when the thing it was meant to describe has already gone wrong.

export interface StorageFacts {
  usage: number
  quota: number
  persisted: boolean
  /**
   * Usage split by storage API, where the browser offers it (Chrome does). Worth having
   * because it answers "is it us?": a tiny `fileSystem` next to a huge `indexedDB` or
   * `caches` says the space went somewhere this app does not control.
   */
  usageDetails?: Record<string, number>
}

export interface Environment {
  userAgent: string
  platform?: string
  /** Approximate RAM in GiB, rounded by the browser for fingerprinting reasons. */
  deviceMemoryGb?: number
  hardwareConcurrency?: number
  /** Bytes the JS heap may grow to. Chrome only, and non-standard. */
  jsHeapLimit?: number
  crossOriginIsolated: boolean
  /**
   * Whether a service worker is controlling this page. False means Neuroglancer's chunk
   * requests reach the network instead of local storage, which renders as black panels
   * with nothing in the console.
   */
  serviceWorkerControlled: boolean
  storage: StorageFacts
}

export async function readStorageFacts(): Promise<StorageFacts> {
  const facts: StorageFacts = { usage: 0, quota: 0, persisted: false }
  try {
    const estimate = await navigator.storage.estimate()
    facts.usage = estimate.usage ?? 0
    facts.quota = estimate.quota ?? 0
    const details = (estimate as { usageDetails?: Record<string, number> })
      .usageDetails
    if (details && Object.keys(details).length > 0) facts.usageDetails = details
  } catch {
    // Left at zero, which `describeStorage` reports as unknown rather than as empty.
  }
  try {
    facts.persisted = await navigator.storage.persisted()
  } catch {
    // Best-effort storage is the default; false is the truthful fallback.
  }
  return facts
}

export async function readEnvironment(): Promise<Environment> {
  const nav = navigator as Navigator & {
    deviceMemory?: number
    platform?: string
  }
  const perf = performance as Performance & {
    memory?: { jsHeapSizeLimit?: number }
  }
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    deviceMemoryGb: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    jsHeapLimit: perf.memory?.jsHeapSizeLimit,
    crossOriginIsolated:
      typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    storage: await readStorageFacts(),
  }
}

/**
 * What the storage numbers mean, said out loud.
 *
 * The point is to close the gap the screenshot left open. A write that fails for space
 * while usage sits at 8 KB of a reported 10 GB is not a quota problem, and saying so in
 * the dialog saves the round of questions that otherwise follows. Reporting the quota
 * without interpreting it is what made that report ambiguous.
 */
export function describeStorage(
  facts: StorageFacts,
  writtenBeforeFailure?: number
): string[] {
  const lines: string[] = []
  if (facts.quota <= 0) {
    lines.push(
      "The browser reported no storage quota, so nothing can be concluded."
    )
    return lines
  }

  const used = facts.usage / facts.quota
  const capped = used < 0.5 && looksLikeFixedCeiling(writtenBeforeFailure)

  if (capped) {
    // Measured, not guessed: a write that stops on an exact power of two has hit a
    // ceiling, because a disk filling up does not land on one. Said first and said
    // plainly, because the alternative below sends someone to check disk space they
    // have plenty of -- which is what happened the first time this was reported.
    lines.push(
      `The write stopped at exactly ${describeBinary(writtenBeforeFailure!)}, which ` +
        `is a round binary figure, and storage was only ` +
        `${(used * 100).toFixed(1)}% full. That is a fixed ceiling rather than space ` +
        `running out -- a disk filling up does not stop on a power of two. Look for ` +
        `what imposes the ceiling: a private or guest window, a managed-Chrome ` +
        `policy, or a container with a storage limit. The machine's free disk space ` +
        `is not the problem.`
    )
  } else if (used < 0.5) {
    lines.push(
      `Storage was ${(used * 100).toFixed(1)}% full when this failed, so the ` +
        `browser's quota was not the limit. Check the machine's free disk space: the ` +
        `quota is a share of it, and the reported figure can be a cap or a stale ` +
        `measurement rather than space that exists. ` +
        `chrome://quota-internals reports what the browser itself believes.`
    )
  }
  if (!facts.persisted) {
    lines.push(
      "Storage is not persisted, so the browser may also be applying a tighter " +
        "limit than it reports. Private and guest windows always report this, and " +
        "give far less room than the quota suggests."
    )
  }
  if (facts.usageDetails) {
    const ours = facts.usageDetails.fileSystem ?? 0
    const total = Object.values(facts.usageDetails).reduce((a, b) => a + b, 0)
    if (total > 0 && ours / total < 0.5) {
      lines.push(
        "Most of the storage in use on this origin belongs to something other than " +
          "this app's converted volumes, so clearing them will not recover much."
      )
    }
  }
  if (
    !capped &&
    writtenBeforeFailure !== undefined &&
    writtenBeforeFailure > 0
  ) {
    lines.push(
      `The write stopped after ${writtenBeforeFailure} bytes. Comparing that with ` +
        `the projected size is the most direct measure of the real limit, since the ` +
        `browser does not expose one.`
    )
  }
  return lines
}

/**
 * Whether a failure point looks like a ceiling rather than exhaustion.
 *
 * An exact power of two, at or above 64 MiB. Chunks are themselves a power of two, so
 * every failure lands on a chunk boundary and that alone means nothing -- what signifies
 * is landing on a round *binary* total, because quotas and policies are written in those
 * and filling a disk is not.
 */
function looksLikeFixedCeiling(bytes: number | undefined): boolean {
  if (bytes === undefined || bytes < 64 * 1024 * 1024) return false
  return (bytes & (bytes - 1)) === 0
}

function describeBinary(bytes: number): string {
  const mib = bytes / 1024 ** 2
  return mib >= 1024 ? `${mib / 1024} GiB` : `${mib} MiB`
}

/** One block of plain text, for pasting into a bug report. */
export function formatEnvironment(env: Environment): string {
  const { storage } = env
  const rows: Array<[string, unknown]> = [
    ["userAgent", env.userAgent],
    ["platform", env.platform],
    ["deviceMemory", env.deviceMemoryGb && `${env.deviceMemoryGb} GiB`],
    ["hardwareConcurrency", env.hardwareConcurrency],
    ["jsHeapLimit", env.jsHeapLimit],
    ["crossOriginIsolated", env.crossOriginIsolated],
    ["serviceWorkerControlled", env.serviceWorkerControlled],
    ["storage.usage", storage.usage],
    ["storage.quota", storage.quota],
    ["storage.persisted", storage.persisted],
    [
      "storage.usageDetails",
      storage.usageDetails && JSON.stringify(storage.usageDetails),
    ],
  ]
  return rows
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== ""
    )
    .map(([label, value]) => `${label}: ${String(value)}`)
    .join("\n")
}

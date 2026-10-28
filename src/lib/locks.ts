// Which datasets are in use, across every tab of this origin.
//
// Storage is shared by every tab on the origin, but each tab only knows what it is
// doing itself. Before startup trimming existed that was nearly enough -- the only
// deleting happened in the tab about to convert, and it protected its own mounted
// volume. Now every tab trims on startup, so one opening could delete the volume another
// is displaying (its view goes black with no error) or a conversion another is halfway
// through (debris, by every rule the trimmer has).
//
// The Web Locks API is the browser's own record of this: a lock lives as long as the
// tab holding it, and any tab can ask which are held. Each tab holds a shared lock on
// what it is using; trimming skips anything locked. Where the API is missing, nothing is
// protected beyond the calling tab's own `keep` list, which is how it was before.

const PREFIX = "h5j-ng-viewer.dataset:"

function locks(): LockManager | null {
  return typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks
    : null
}

/**
 * Mark a dataset as in use until the returned function is called, or the tab closes.
 * Shared, so any number of tabs can hold it at once -- this records use, it does not
 * grant exclusive access.
 */
export function holdDataset(datasetId: string): () => void {
  const manager = locks()
  if (!manager) return () => undefined
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  manager
    .request(PREFIX + datasetId, { mode: "shared" }, () => released)
    .catch(() => undefined)
  return release
}

/** Every dataset some tab of this origin holds, including this one. Never throws. */
export async function datasetsInUse(): Promise<string[]> {
  const manager = locks()
  if (!manager) return []
  try {
    const { held = [] } = await manager.query()
    return held
      .map((lock) => lock.name ?? "")
      .filter((name) => name.startsWith(PREFIX))
      .map((name) => name.slice(PREFIX.length))
  } catch {
    return []
  }
}

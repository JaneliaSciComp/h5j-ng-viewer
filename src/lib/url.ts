// The app's own search parameters: what to load, and how the view should start.
//
// These exist so another web application can launch this one with particular data, and
// so a session can be shared or reloaded. That is why they are named and readable
// rather than one opaque encoded blob -- a caller can construct a link without knowing
// anything about Neuroglancer's state schema.
//
//   ?h5j=<url-encoded H5J URL>   required; the file to load
//   &chs=0,1                     channel indices into the container; default: all
//   &col=ff00ff,00ff00           per-channel color, no leading '#'
//   &pos=605,283,87              voxel position, i.e. which slice to start on
//   &zoom=1                      voxels per screen pixel in the cross-section views
//
// Everything except `h5j` is optional, and anything unrecognized is ignored: a link
// from an older or newer build must never fail to load, it must just lose a detail.

export interface LaunchParams {
  /** The H5J to load. Null when the app was opened with no parameters. */
  h5jUrl: string | null
  /** Channel indices from `chs`, in the order given. Null means "all of them". */
  channels: number[] | null
  /**
   * Per-channel color as `#rrggbb`, positional. A null entry means "no override for
   * this channel" -- entries are never dropped, because dropping one would silently
   * shift every color after it onto the wrong channel.
   */
  colors: Array<string | null> | null
  /** Initial voxel position, or null to center on the volume. */
  position: [number, number, number] | null
  /** Initial cross-section scale in voxels per pixel, or null for the default. */
  zoom: number | null
}

export const NO_PARAMS: LaunchParams = {
  h5jUrl: null,
  channels: null,
  colors: null,
  position: null,
  zoom: null,
}

export function parseParams(search: string): LaunchParams {
  const params = new URLSearchParams(search)
  return {
    h5jUrl: params.get("h5j") || null,
    channels: parseChannels(params.get("chs")),
    colors: parseColors(params.get("col")),
    position: parsePosition(params.get("pos")),
    zoom: parseZoom(params.get("zoom")),
  }
}

/**
 * The search string for a launch, including the leading "?", or "" when there is
 * nothing worth putting in the address bar. Only `h5j` makes a link meaningful, so
 * without it nothing else is emitted either.
 */
export function serializeParams(launch: LaunchParams): string {
  if (!launch.h5jUrl) return ""
  const params = new URLSearchParams()
  params.set("h5j", launch.h5jUrl)
  if (launch.channels) params.set("chs", launch.channels.join(","))
  if (launch.colors) {
    params.set(
      "col",
      launch.colors.map((color) => (color ?? "").replace(/^#/, "")).join(",")
    )
  }
  if (launch.position) params.set("pos", launch.position.join(","))
  if (launch.zoom !== null) params.set("zoom", String(launch.zoom))
  return `?${params.toString()}`
}

/**
 * The part of a source worth showing: the last path segment.
 *
 * Presigned S3 URLs carry a `?X-Amz-...` query and some links carry a fragment, so
 * both are stripped before the split -- otherwise the signature ends up in the label.
 * Percent-escapes are decoded; a literal `+` is left alone, because in a *path* it is
 * a plus sign and not a space. A `File.name` passes through unchanged.
 */
export function basenameOf(source: string): string {
  const withoutQuery = source.split(/[?#]/, 1)[0]
  const segments = withoutQuery.split(/[/\\]/).filter(Boolean)
  const last = segments[segments.length - 1] ?? ""
  if (!last) return source
  try {
    return decodeURIComponent(last)
  } catch {
    // A stray '%' is not a reason to fail a load.
    return last
  }
}

function parseChannels(value: string | null): number[] | null {
  if (!value) return null
  const seen = new Set<number>()
  for (const part of value.split(",")) {
    const index = Number(part.trim())
    if (Number.isInteger(index) && index >= 0) seen.add(index)
  }
  return seen.size > 0 ? [...seen] : null
}

function parseColors(value: string | null): Array<string | null> | null {
  if (!value) return null
  const colors = value.split(",").map((part) => {
    const hex = part.trim().replace(/^#/, "")
    return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null
  })
  return colors.some((color) => color !== null) ? colors : null
}

function parsePosition(value: string | null): [number, number, number] | null {
  if (!value) return null
  const parts = value.split(",").map((part) => Number(part.trim()))
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return [parts[0], parts[1], parts[2]]
}

function parseZoom(value: string | null): number | null {
  if (!value) return null
  const zoom = Number(value)
  return Number.isFinite(zoom) && zoom > 0 ? zoom : null
}

/**
 * Which channels start out visible, one flag per channel in the container.
 *
 * An out-of-range index is ignored rather than fatal -- a link should lose a channel,
 * not fail to open. No indices at all, or none of them usable, means show everything:
 * a blank viewer is a worse answer to a broken link than an over-full one.
 */
export function visibilityFor(
  channelCount: number,
  indices: number[] | null
): boolean[] {
  const all = Array.from({ length: channelCount }, () => true)
  if (!indices) return all
  const wanted = indices.filter((index) => index >= 0 && index < channelCount)
  if (wanted.length === 0) return all
  const visible = Array.from({ length: channelCount }, () => false)
  for (const index of wanted) visible[index] = true
  return visible
}

/**
 * The inverse, for writing the address bar back. Null when everything is visible, so
 * the common case leaves `chs` out of the URL entirely.
 */
export function visibleIndices(visible: boolean[]): number[] | null {
  if (visible.length === 0 || visible.every(Boolean)) return null
  return visible.flatMap((shown, index) => (shown ? [index] : []))
}

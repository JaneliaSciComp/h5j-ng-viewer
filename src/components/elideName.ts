// The elision rule, apart from the component that renders it -- same split as
// chipState.ts and swatches.ts, so the pure part can be tested without a DOM.

/** Characters that mark a word boundary in a file name. */
const SEPARATOR = /[-_. ]/

/** Shortest tail worth protecting: enough for an extension and the token before it. */
const MIN_TAIL = 10

/** Longest, so a name with no separator near the end does not keep the whole thing. */
const MAX_TAIL = 24

/**
 * Split a name into the part that may be ellipsized and the part that must survive.
 *
 * The tail is the SHORTEST suffix that is at least `MIN_TAIL` long and starts on a word
 * boundary -- shortest, because for these names the head is where the identifying
 * information is, so every character given to the tail is one taken from the part worth
 * reading. Falls back to a blunt character count when nothing in range is a boundary,
 * and returns no tail at all for a name short enough to show whole.
 */
export function splitForMiddleElision(
  name: string
): [head: string, tail: string] {
  if (name.length <= MIN_TAIL * 2) return [name, ""]

  const earliest = Math.max(0, name.length - MAX_TAIL)
  for (let at = name.length - MIN_TAIL; at >= earliest; at -= 1) {
    if (SEPARATOR.test(name[at])) return [name.slice(0, at), name.slice(at)]
  }
  const at = name.length - MIN_TAIL
  return [name.slice(0, at), name.slice(at)]
}

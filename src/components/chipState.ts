// A channel's display state, kept out of ChannelStrip.tsx because a module that exports a
// component must export only components for React Fast Refresh -- the same reason the
// store's hooks live apart from its provider.

export type ChipState = "queued" | "converting" | "hidden" | "visible"

/**
 * What a channel's controls are showing. Load status and visibility are separate axes: a
 * channel can be converting, or loaded and hidden, or loaded and shown.
 */
export function chipState(
  index: number,
  status: {
    ready: boolean[]
    visible: boolean[]
    convertingIndex: number | null
  }
): ChipState {
  if (status.ready[index] !== true) {
    return status.convertingIndex === index ? "converting" : "queued"
  }
  return status.visible[index] === false ? "hidden" : "visible"
}

/**
 * Tooltip text, naming the action the next click will perform rather than describing
 * the control -- which is how Neuroglancer teaches the same convention.
 */
export function chipTitle(
  name: string,
  state: ChipState,
  fraction: number | null
): string {
  switch (state) {
    case "queued":
      return `${name} — waiting to convert`
    case "converting":
      return fraction === null
        ? `${name} — converting`
        : `${name} — converting, ${Math.round(fraction * 100)}%`
    case "hidden":
      return `${name} — click to show, right-click to edit`
    case "visible":
      return `${name} — click to hide, right-click to edit`
  }
}

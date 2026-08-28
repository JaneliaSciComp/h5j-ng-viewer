import type { CSSProperties, ReactElement } from "react"
import { chipState, chipTitle } from "@/components/chipState"
import type { ChannelInfo } from "@/types"

/**
 * One chip per channel in the container, showing the channel's 0-based index. Numbering
 * matches the `chs` search parameter and the container's own `Channel_0…` names, so the
 * bar, the URL and the help text all agree.
 *
 * A chip carries two independent bits -- is this channel shown, and is it the one the
 * eye and swatch act on -- so these are toggle buttons with a current-item marker, not
 * radios: `<input type="radio">` could not express visibility at all.
 *
 * Gestures follow Neuroglancer's own layer bar, so the muscle memory transfers:
 *
 *   left click            toggle visibility
 *   right click           make this the channel being edited, and show it
 *   Cmd/Ctrl + click      the same -- the only one of the two available on a trackpad,
 *                         on touch, or from the keyboard
 *   Space / Enter         toggle visibility (the focused chip)
 *
 * Neuroglancer's right click opens the layer's side panel rather than showing the layer;
 * revealing it here is deliberate, because the eye and swatch are already in the bar, so
 * the only reason to select a channel is to edit it -- and editing something invisible
 * is a dead end.
 */

export function ChannelChips(props: {
  channels: ChannelInfo[]
  visible: boolean[]
  ready: boolean[]
  /** Which channel is converting right now, if any. */
  convertingIndex: number | null
  /** Progress of that channel, 0..1. */
  fraction: number | null
  /** Which channel the eye and swatch act on. */
  picked: number | null
  /** Rendering color per channel, indexed by the channel's own position. */
  colors: string[]
  onToggleVisibility: (index: number) => void
  onPick: (index: number) => void
}): ReactElement {
  return (
    <div className="channel-chips" role="group" aria-label="Channels">
      {props.channels.map((channel, index) => {
        const state = chipState(index, {
          ready: props.ready,
          visible: props.visible,
          convertingIndex: props.convertingIndex,
        })
        const loaded = state === "hidden" || state === "visible"
        const picked = props.picked === index
        // The ring advances with the data rather than animating, so there is no motion
        // to reduce and nothing to special-case for prefers-reduced-motion.
        const progress =
          state === "converting" && props.fraction !== null
            ? `${Math.round(props.fraction * 100)}%`
            : "0%"

        return (
          <button
            key={channel.name}
            type="button"
            className="channel-chip"
            style={
              {
                "--chip-color": props.colors[index],
                "--chip-progress": progress,
              } as CSSProperties
            }
            data-state={state}
            data-picked={picked}
            aria-pressed={state === "visible"}
            aria-current={picked ? "true" : undefined}
            disabled={!loaded}
            title={chipTitle(channel.name, state, props.fraction)}
            onClick={(event) => {
              // Cmd/Ctrl-click is Neuroglancer's own synonym for right click, and the
              // only route available without a mouse.
              if (event.metaKey || event.ctrlKey) props.onPick(index)
              else props.onToggleVisibility(index)
            }}
            onContextMenu={(event) => {
              // Without this the browser menu appears instead of the pick happening.
              event.preventDefault()
              props.onPick(index)
            }}
          >
            {index}
          </button>
        )
      })}
    </div>
  )
}

import type { CSSProperties, ReactElement } from "react"
import { chipState, chipTitle } from "@/components/chipState"
import { ChannelPopover } from "@/components/ChannelPopover"
import type { ChannelInfo } from "@/types"

/**
 * One control group per channel, laid out inline: a "Ch N" label, an eye that toggles
 * visibility, a color swatch that opens the color chooser, and an opacity slider. Every
 * channel carries its own set, so there is no "channel being edited" -- each control acts
 * on the channel it sits under.
 *
 * Numbering is 0-based, matching the `chs` search parameter and the container's own
 * `Channel_0…` names, so the bar, the URL and the help text all agree.
 *
 * A channel that is not yet readable shows a thin progress bar beneath its (disabled)
 * controls rather than vanishing: the group keeps its place, and the bar fills as that
 * channel converts. It sits under the controls, not beside them, so it can be a few pixels
 * tall without making the whole bar taller.
 */
export function ChannelStrip(props: {
  channels: ChannelInfo[]
  visible: boolean[]
  ready: boolean[]
  /** Rendering color per channel, indexed by the channel's own position. */
  colors: string[]
  /** 0..1 per channel. */
  opacity: number[]
  /** Which channel is converting right now, if any. */
  convertingIndex: number | null
  /** Progress of that channel, 0..1. */
  fraction: number | null
  onToggleVisibility: (index: number) => void
  onColorChange: (index: number, color: string) => void
  onOpacityChange: (index: number, opacity: number) => void
}): ReactElement {
  return (
    <div className="channel-strip" role="group" aria-label="Channels">
      {props.channels.map((channel, index) => {
        const state = chipState(index, {
          ready: props.ready,
          visible: props.visible,
          convertingIndex: props.convertingIndex,
        })
        const loaded = state === "hidden" || state === "visible"
        const visible = state === "visible"
        const opacity = props.opacity[index] ?? 1
        const popoverId = `channel-popover-${index}`

        // The converting channel has a live fraction; a merely queued one shows an empty
        // track, so the group does not resize the moment it starts filling.
        const showProgress = state === "converting" || state === "queued"
        const fraction =
          state === "converting" && props.fraction !== null ? props.fraction : 0

        // Naming what the next click does when loaded; when not, saying where it is in the
        // queue -- the same convention Neuroglancer's own layer bar uses for its tooltips.
        const visibilityAction = `${visible ? "Hide" : "Show"} channel ${index}`
        const visibilityTitle = loaded
          ? visibilityAction
          : chipTitle(`Channel ${index}`, state, props.fraction)
        const colorTitle = loaded
          ? `Color and opacity for channel ${index}`
          : chipTitle(`Channel ${index}`, state, props.fraction)

        return (
          <div
            key={channel.name}
            className="channel-group"
            style={{ "--chip-color": props.colors[index] } as CSSProperties}
            data-state={state}
          >
            <div className="channel-controls-row">
              <span className="channel-label">Ch {index}</span>

              <button
                type="button"
                className="icon-button"
                disabled={!loaded}
                aria-pressed={visible}
                aria-label={visibilityAction}
                title={visibilityTitle}
                onClick={() => props.onToggleVisibility(index)}
              >
                {/* Open and closed eye, drawn rather than pulled from an icon font so the
                    bar carries no extra dependency. */}
                <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
                  <path
                    d="M1 10s3.5-5.5 9-5.5 9 5.5 9 5.5-3.5 5.5-9 5.5S1 10 1 10z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  {visible ? (
                    <circle cx="10" cy="10" r="2.6" fill="currentColor" />
                  ) : (
                    <line
                      x1="3"
                      y1="17"
                      x2="17"
                      y2="3"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                  )}
                </svg>
              </button>

              <button
                type="button"
                className="swatch-button"
                style={{
                  backgroundColor: loaded ? props.colors[index] : "transparent",
                  // Its own anchor name, so this channel's popover opens under this swatch.
                  anchorName: `--swatch-${index}`,
                }}
                disabled={!loaded}
                popoverTarget={loaded ? popoverId : undefined}
                aria-label={`Color and opacity for channel ${index}`}
                title={colorTitle}
              />

              <input
                type="range"
                className="channel-opacity"
                min={0}
                max={1}
                step={0.05}
                value={opacity}
                disabled={!loaded}
                aria-label={`Opacity for channel ${index}`}
                title={
                  loaded
                    ? `Opacity for channel ${index}: ${Math.round(opacity * 100)}%`
                    : colorTitle
                }
                onChange={(event) =>
                  props.onOpacityChange(index, Number(event.target.value))
                }
              />
            </div>

            {showProgress ? (
              // The fill advances with the data rather than animating, so there is no
              // motion to reduce and nothing to special-case for prefers-reduced-motion.
              <span
                className="channel-progress"
                style={
                  { "--progress": `${Math.round(fraction * 100)}%` } as CSSProperties
                }
                aria-hidden="true"
              />
            ) : null}

            {loaded ? (
              <ChannelPopover
                id={popoverId}
                anchorName={`--swatch-${index}`}
                channelName={`Channel ${index}`}
                color={props.colors[index]}
                onColorChange={(color) => props.onColorChange(index, color)}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

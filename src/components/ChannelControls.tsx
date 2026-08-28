import type { ReactElement } from "react"
import { ChannelPopover } from "@/components/ChannelPopover"

const POPOVER_ID = "channel-popover"

/**
 * The eye, the opacity slider and the color swatch, all acting on whichever channel is
 * currently being edited. One set of controls rather than one per channel is what keeps
 * the bar's width independent of how many channels a container has.
 *
 * Opacity sits in the bar rather than behind the swatch because it is adjusted often and
 * benefits from being a single drag away; color is chosen occasionally, so it can cost
 * a click.
 *
 * Both are disabled when nothing is ready: a channel that has not finished converting
 * cannot be shown, so offering to change how it looks would be a lie.
 */
export function ChannelControls(props: {
  /** The channel being edited, or null when none is ready. */
  channel: {
    index: number
    name: string
    visible: boolean
    color: string
  } | null
  opacity: number
  onToggleVisibility: (index: number) => void
  onColorChange: (index: number, color: string) => void
  onOpacityChange: (index: number, opacity: number) => void
}): ReactElement {
  const { channel } = props
  const disabled = channel === null

  return (
    <div className="channel-controls">
      <button
        type="button"
        className="icon-button"
        disabled={disabled}
        aria-pressed={channel?.visible ?? false}
        aria-label={
          channel
            ? `${channel.visible ? "Hide" : "Show"} ${channel.name}`
            : "Show or hide the channel being edited"
        }
        title={
          channel
            ? `${channel.visible ? "Hide" : "Show"} ${channel.name}`
            : "No channel is ready yet"
        }
        onClick={() => channel && props.onToggleVisibility(channel.index)}
      >
        {/* Open and closed eye, drawn rather than pulled from an icon font so the bar
            carries no extra dependency. */}
        <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
          <path
            d="M1 10s3.5-5.5 9-5.5 9 5.5 9 5.5-3.5 5.5-9 5.5S1 10 1 10z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          {channel?.visible ? (
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

      <input
        type="range"
        className="bar-opacity"
        min={0}
        max={1}
        step={0.05}
        value={props.opacity}
        disabled={disabled}
        aria-label={channel ? `Opacity for ${channel.name}` : "Opacity"}
        title={
          channel
            ? `Opacity for ${channel.name}: ${Math.round(props.opacity * 100)}%`
            : "No channel is ready yet"
        }
        onChange={(event) =>
          channel &&
          props.onOpacityChange(channel.index, Number(event.target.value))
        }
      />
      {/* Fixed width and tabular figures, so the controls beside it do not shift as the
          number changes width during a drag. */}
      <span className="bar-opacity-value">
        {disabled ? "—" : `${Math.round(props.opacity * 100)}%`}
      </span>

      <button
        type="button"
        className="swatch-button"
        style={{ backgroundColor: channel?.color ?? "transparent" }}
        disabled={disabled}
        popoverTarget={disabled ? undefined : POPOVER_ID}
        aria-label={
          channel
            ? `Color and opacity for ${channel.name}`
            : "Color and opacity"
        }
        title={
          channel
            ? `Color and opacity for ${channel.name}`
            : "No channel is ready yet"
        }
      />

      {channel ? (
        <ChannelPopover
          id={POPOVER_ID}
          channelName={channel.name}
          color={channel.color}
          onColorChange={(color) => props.onColorChange(channel.index, color)}
        />
      ) : null}
    </div>
  )
}

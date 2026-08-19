import { useId } from "react"
import type { ReactElement } from "react"
import type { BitDepth, ChannelInfo } from "@/types"

export function ChannelList(props: {
  channels: ChannelInfo[]
  /** Channel names currently selected, in the order they will occupy the c axis. */
  selected: string[]
  onChange: (selected: string[]) => void
  bits: BitDepth
  onBitsChange: (bits: BitDepth) => void
  /** CSS hex per selected channel, parallel to `selected`; render as a colour swatch. */
  colors?: string[]
  disabled?: boolean
}): ReactElement {
  const groupId = useId()

  function toggle(name: string, checked: boolean): void {
    if (checked) {
      // Preserve channel-declaration order, do not append to the end.
      const next = props.channels
        .map((c) => c.name)
        .filter((n) => n === name || props.selected.includes(n))
      props.onChange(next)
    } else {
      props.onChange(props.selected.filter((n) => n !== name))
    }
  }

  return (
    <fieldset className="channel-list" disabled={props.disabled}>
      <legend>Channels</legend>
      <ul>
        {props.channels.map((channel) => {
          const checkboxId = `${groupId}-${channel.name}`
          const index = props.selected.indexOf(channel.name)
          const color = index >= 0 ? props.colors?.[index] : undefined
          return (
            <li key={channel.name}>
              <input
                id={checkboxId}
                type="checkbox"
                checked={index >= 0}
                onChange={(e) => toggle(channel.name, e.target.checked)}
              />
              <label htmlFor={checkboxId}>
                {channel.name}
                {channel.contentType ? (
                  <span className="channel-content-type">
                    {" "}
                    ({channel.contentType})
                  </span>
                ) : null}
              </label>
              {color ? (
                <span
                  className="channel-swatch"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      <div
        className="bit-depth-toggle"
        role="radiogroup"
        aria-label="Bit depth"
      >
        <span className="radio-option">
          <input
            id={`${groupId}-bits16`}
            type="radio"
            name={`${groupId}-bits`}
            checked={props.bits === 16}
            onChange={() => props.onBitsChange(16)}
          />
          <label htmlFor={`${groupId}-bits16`}>
            16-bit (preserves original 12-bit values)
          </label>
        </span>
        <span className="radio-option">
          <input
            id={`${groupId}-bits8`}
            type="radio"
            name={`${groupId}-bits`}
            checked={props.bits === 8}
            onChange={() => props.onBitsChange(8)}
          />
          <label htmlFor={`${groupId}-bits8`}>8-bit (halves memory)</label>
        </span>
      </div>
    </fieldset>
  )
}

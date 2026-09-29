import type { ReactElement } from "react"
import { ColorField } from "@/components/ColorField"

/**
 * Choosing a color for one channel, opened from the swatch in the bar. Just the color:
 * opacity is adjusted often enough to earn permanent space in the bar itself.
 *
 * The picker is drawn here rather than delegated to `<input type="color">`, so that
 * everything is one click away. The native input opens a browser dialog outside the
 * document, which cannot be embedded, styled or dismissed by us -- reaching a custom
 * color through it costs a second click and a second thing to close.
 *
 * Uses the native `popover` attribute rather than hand-rolled open state: it brings
 * light dismiss, Esc, and top-layer stacking with no JavaScript, which is three fewer
 * things to get wrong. Positioning is CSS anchor positioning where available, with a
 * fixed offset under the bar as the fallback -- see index.css.
 *
 * It also carries an explicit close button. Light dismiss and Esc both work, but neither
 * is visible, and a panel with no way out that you can *see* reads as stuck. There is
 * nothing to cancel: every choice applies as it is made, and undo is the way back.
 */

/**
 * Fixed choices, offered before the full picker: the Turbo colormap sampled every 0.125,
 * at the center of each eighth rather than at its edge.
 *
 * Turbo is designed so that neighboring samples stay distinguishable, which is the
 * property that matters when several channels are blended additively into one image --
 * an evenly spaced set from it separates better than an ad-hoc palette does. Taking the
 * bin centers keeps that even spacing while avoiding both ends of the ramp, where Turbo
 * goes very dark: additive blending scales with luminance, so a near-black channel
 * color reads as absent even at full opacity, which is a second hide button rather
 * than a color.
 *
 * Values are the canonical 256-entry table, not the published polynomial approximation,
 * which drifts at the ends.
 */
export const SWATCHES = [
  "#4040a2", // t = 0.0625
  "#4294ff", // t = 0.1875
  "#18ddc2", // t = 0.3125
  "#6dfe62", // t = 0.4375
  "#cbed34", // t = 0.5625
  "#fdae35", // t = 0.6875
  "#ec530f", // t = 0.8125
  "#ac1701", // t = 0.9375
] as const

export function ChannelPopover(props: {
  id: string
  /** The swatch's anchor name, so the popover opens under the swatch that owns it. */
  anchorName: string
  channelName: string
  color: string
  onColorChange: (color: string) => void
}): ReactElement {
  return (
    <div
      id={props.id}
      popover="auto"
      className="channel-popover"
      style={{ positionAnchor: props.anchorName }}
      aria-label={`Color for ${props.channelName}`}
    >
      <div className="popover-header">
        <span className="popover-title">{props.channelName} color</span>
        <button
          type="button"
          className="popover-close"
          popoverTarget={props.id}
          popoverTargetAction="hide"
          title="Close (Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="popover-row">
        <div className="swatch-grid">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className="swatch-choice"
              style={{ backgroundColor: swatch }}
              aria-label={`Use ${swatch}`}
              aria-pressed={props.color.toLowerCase() === swatch}
              title={`Use ${swatch}`}
              onClick={() => props.onColorChange(swatch)}
            />
          ))}
        </div>
      </div>

      <ColorField color={props.color} onChange={props.onColorChange} />
    </div>
  )
}

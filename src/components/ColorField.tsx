import { useRef, useState } from "react"
import type { CSSProperties, PointerEvent, ReactElement } from "react"
import { hexToHsv, hsvToHex, parseHex, setChannel } from "@/lib/color"

/**
 * A color picker drawn in the page: saturation/value square, hue slider, red/green/blue
 * sliders, hex field. Three ways at the same color, because they suit different
 * intentions -- the square for "something like that", the hue slider for "the same but
 * bluer", the channel sliders for "a bit less red", the hex field for an exact value.
 *
 * `<input type="color">` would be less code, but it opens a browser dialog that lives
 * outside the document — so reaching a custom color costs a second click, and the
 * dialog cannot be styled, positioned or closed by us. Drawn here, the whole picker is
 * visible the moment the popover opens.
 *
 * The square is two gradients over a pure hue: white fading out to the right gives
 * saturation, black fading out upwards gives value. That is the same construction every
 * picker uses, and it means the browser does the interpolation.
 */
export function ColorField(props: {
  color: string
  onChange: (color: string) => void
}): ReactElement {
  const squareRef = useRef<HTMLDivElement>(null)
  const measured = hexToHsv(props.color)
  const rgb = parseHex(props.color) ?? [0, 0, 0]

  // A gray has no hue of its own, so the slider would snap to red as soon as the user
  // dragged to the left edge of the square. Remember the last hue that meant something.
  const [heldHue, setHeldHue] = useState(measured.h)
  const hue = measured.s === 0 ? heldHue : measured.h

  // Typing a hex is character by character: "#ff00" is not a color yet, so the field
  // keeps its own text until the value parses.
  const [typed, setTyped] = useState<string | null>(null)

  function applyFromSquare(event: PointerEvent<HTMLDivElement>): void {
    const box = squareRef.current?.getBoundingClientRect()
    if (!box || box.width === 0 || box.height === 0) return
    const s = clamp01((event.clientX - box.left) / box.width)
    const v = clamp01(1 - (event.clientY - box.top) / box.height)
    props.onChange(hsvToHex({ h: hue, s, v }))
  }

  return (
    <div className="color-field">
      <div
        ref={squareRef}
        className="color-square"
        style={{ "--field-hue": `${hue}` } as CSSProperties}
        role="application"
        aria-label="Saturation and brightness"
        onPointerDown={(event) => {
          // Capture so a drag that leaves the square keeps working, which is how every
          // other picker behaves.
          event.currentTarget.setPointerCapture(event.pointerId)
          applyFromSquare(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            applyFromSquare(event)
          }
        }}
      >
        <span
          className="color-thumb"
          style={
            {
              left: `${measured.s * 100}%`,
              top: `${(1 - measured.v) * 100}%`,
            } as CSSProperties
          }
        />
      </div>

      <input
        type="range"
        className="hue-slider"
        min={0}
        max={359}
        step={1}
        value={Math.round(hue)}
        aria-label="Hue"
        title={`Hue ${Math.round(hue)}°`}
        onChange={(event) => {
          const next = Number(event.target.value)
          setHeldHue(next)
          props.onChange(
            hsvToHex({ h: next, s: measured.s, v: measured.v || 1 })
          )
        }}
      />

      {/* Each channel's track shows what moving it would do: the gradient runs from
          this color with that channel at 0 to the same color with it at full. */}
      {CHANNELS.map(({ key, label }) => {
        const value = rgb[CHANNEL_INDEX[key]]
        const from = setChannel(props.color, key, 0)
        const to = setChannel(props.color, key, 255)
        return (
          <div className="rgb-row" key={key}>
            <span className="rgb-label">{label}</span>
            <input
              type="range"
              className="rgb-slider"
              min={0}
              max={255}
              step={1}
              value={value}
              style={{
                backgroundImage: `linear-gradient(to right, ${from}, ${to})`,
              }}
              aria-label={`${label} channel`}
              title={`${label} ${value}`}
              onChange={(event) =>
                props.onChange(
                  setChannel(props.color, key, Number(event.target.value))
                )
              }
            />
            <span className="rgb-value">{value}</span>
          </div>
        )
      })}

      <input
        type="text"
        className="hex-input"
        spellCheck={false}
        value={typed ?? props.color}
        aria-label="Color as hex"
        title="Color as hex, e.g. #4294ff"
        onChange={(event) => {
          const text = event.target.value
          setTyped(text)
          const parsed = parseHex(text)
          if (parsed) props.onChange(`#${text.replace(/^#/, "").toLowerCase()}`)
        }}
        onBlur={() => setTyped(null)}
      />
    </div>
  )
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

const CHANNELS = [
  { key: "r" as const, label: "R" },
  { key: "g" as const, label: "G" },
  { key: "b" as const, label: "B" },
]

const CHANNEL_INDEX = { r: 0, g: 1, b: 2 }
